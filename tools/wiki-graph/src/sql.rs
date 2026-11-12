//! Streaming parser for MediaWiki `mysqldump` / `mariadb-dump` table dumps.
//!
//! The dumps are tens of gigabytes uncompressed, so nothing here loads a
//! statement into memory: rows are yielded one at a time from a byte stream and
//! each row reuses the caller's buffers.
//!
//! Both dump layouts are accepted: the legacy one with every tuple of an
//! `INSERT` on a single line, and the current one with a newline between tuples.

use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::Path;
use std::sync::mpsc::{sync_channel, Receiver};
use std::thread::{self, JoinHandle};

use anyhow::{anyhow, bail, Context, Result};
use flate2::read::MultiGzDecoder;

const READ_BUFFER_BYTES: usize = 1 << 20;
const MAX_PREAMBLE_LINE_BYTES: usize = 1 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FieldKind {
    Null,
    /// Unquoted token: a number.
    Raw,
    /// Quoted string with escapes already decoded.
    Str,
}

#[derive(Clone, Copy, Debug)]
struct Field {
    kind: FieldKind,
    start: usize,
    end: usize,
}

/// One parsed tuple. Reused across rows to avoid per-row allocation.
#[derive(Default, Debug)]
pub struct Row {
    data: Vec<u8>,
    fields: Vec<Field>,
}

impl Row {
    pub fn new() -> Self {
        Row::default()
    }

    fn clear(&mut self) {
        self.data.clear();
        self.fields.clear();
    }

    pub fn len(&self) -> usize {
        self.fields.len()
    }

    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }

    fn field(&self, index: usize) -> Result<&Field> {
        self.fields
            .get(index)
            .ok_or_else(|| anyhow!("row has {} fields, wanted index {index}", self.fields.len()))
    }

    pub fn is_null(&self, index: usize) -> Result<bool> {
        Ok(self.field(index)?.kind == FieldKind::Null)
    }

    /// Field bytes with SQL escapes decoded; `None` for SQL `NULL`.
    pub fn bytes(&self, index: usize) -> Result<Option<&[u8]>> {
        let field = self.field(index)?;
        Ok(match field.kind {
            FieldKind::Null => None,
            _ => Some(&self.data[field.start..field.end]),
        })
    }

    pub fn u64(&self, index: usize) -> Result<u64> {
        let field = self.field(index)?;
        let bytes = &self.data[field.start..field.end];
        if field.kind == FieldKind::Null || bytes.is_empty() {
            bail!("field {index} is not an unsigned integer");
        }
        let mut value: u64 = 0;
        for &b in bytes {
            if !b.is_ascii_digit() {
                bail!(
                    "field {index} is not an unsigned integer: {:?}",
                    String::from_utf8_lossy(bytes)
                );
            }
            value = value
                .checked_mul(10)
                .and_then(|v| v.checked_add((b - b'0') as u64))
                .ok_or_else(|| anyhow!("field {index} overflows u64"))?;
        }
        Ok(value)
    }

    pub fn i64(&self, index: usize) -> Result<i64> {
        let field = self.field(index)?;
        let bytes = &self.data[field.start..field.end];
        if field.kind == FieldKind::Null || bytes.is_empty() {
            bail!("field {index} is not an integer");
        }
        let (negative, digits) = match bytes[0] {
            b'-' => (true, &bytes[1..]),
            _ => (false, bytes),
        };
        if digits.is_empty() {
            bail!("field {index} is not an integer");
        }
        let mut value: i64 = 0;
        for &b in digits {
            if !b.is_ascii_digit() {
                bail!(
                    "field {index} is not an integer: {:?}",
                    String::from_utf8_lossy(bytes)
                );
            }
            value = value
                .checked_mul(10)
                .and_then(|v| v.checked_add((b - b'0') as i64))
                .ok_or_else(|| anyhow!("field {index} overflows i64"))?;
        }
        Ok(if negative { -value } else { value })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Preamble,
    Tuples,
}

/// Pull parser over one table dump.
pub struct SqlDump<R: Read> {
    reader: R,
    buf: Box<[u8]>,
    pos: usize,
    len: usize,
    state: State,
    table: String,
    create_table: Option<String>,
    in_create: bool,
    columns: Vec<String>,
    line: Vec<u8>,
    rows: u64,
}

impl<R: Read> SqlDump<R> {
    /// `table` is the table every `CREATE TABLE` / `INSERT INTO` must name.
    pub fn new(reader: R, table: &str) -> Self {
        SqlDump {
            reader,
            buf: vec![0u8; READ_BUFFER_BYTES].into_boxed_slice(),
            pos: 0,
            len: 0,
            state: State::Preamble,
            table: table.to_string(),
            create_table: None,
            in_create: false,
            columns: Vec::new(),
            line: Vec::new(),
            rows: 0,
        }
    }

    pub fn rows_read(&self) -> u64 {
        self.rows
    }

    /// Column names from `CREATE TABLE`, available once the first row has been
    /// read (the definition always precedes the data).
    pub fn columns(&self) -> &[String] {
        &self.columns
    }

    /// Position of a named column. Resolving by name rather than hard-coding
    /// positions makes the build fail loudly if Wikimedia changes a schema.
    pub fn column(&self, name: &str) -> Result<usize> {
        self.columns.iter().position(|c| c == name).ok_or_else(|| {
            anyhow!(
                "table `{}` has no column `{name}` (columns: {})",
                self.table,
                self.columns.join(", ")
            )
        })
    }

    fn fill(&mut self) -> Result<bool> {
        loop {
            match self.reader.read(&mut self.buf) {
                Ok(0) => return Ok(false),
                Ok(n) => {
                    self.pos = 0;
                    self.len = n;
                    return Ok(true);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e).context("reading SQL dump"),
            }
        }
    }

    #[inline]
    fn next_byte(&mut self) -> Result<Option<u8>> {
        if self.pos == self.len && !self.fill()? {
            return Ok(None);
        }
        let b = self.buf[self.pos];
        self.pos += 1;
        Ok(Some(b))
    }

    #[inline]
    fn must_next(&mut self) -> Result<u8> {
        self.next_byte()?
            .ok_or_else(|| anyhow!("unexpected end of dump inside a `{}` tuple", self.table))
    }

    #[inline]
    fn peek_byte(&mut self) -> Result<Option<u8>> {
        if self.pos == self.len && !self.fill()? {
            return Ok(None);
        }
        Ok(Some(self.buf[self.pos]))
    }

    /// Reads the next row into `row`. Returns `false` at end of dump.
    pub fn next_row(&mut self, row: &mut Row) -> Result<bool> {
        loop {
            match self.state {
                State::Preamble => {
                    if !self.read_preamble()? {
                        return Ok(false);
                    }
                }
                State::Tuples => {
                    let b = loop {
                        match self.next_byte()? {
                            None => bail!(
                                "unexpected end of dump inside an INSERT into `{}`",
                                self.table
                            ),
                            Some(b' ' | b'\n' | b'\r' | b'\t' | b',') => continue,
                            Some(b) => break b,
                        }
                    };
                    match b {
                        b'(' => {
                            self.read_tuple(row)?;
                            self.rows += 1;
                            return Ok(true);
                        }
                        b';' => self.state = State::Preamble,
                        other => bail!(
                            "unexpected byte {:?} between `{}` tuples after row {}",
                            other as char,
                            self.table,
                            self.rows
                        ),
                    }
                }
            }
        }
    }

    /// Consumes non-data lines until an `INSERT ... VALUES` is found.
    /// Returns `false` at end of dump.
    fn read_preamble(&mut self) -> Result<bool> {
        loop {
            self.line.clear();
            let mut at_eof = false;
            loop {
                match self.next_byte()? {
                    None => {
                        at_eof = true;
                        break;
                    }
                    Some(b'\n') => break,
                    Some(b) => {
                        self.line.push(b);
                        if b == b'S'
                            && self.line.starts_with(b"INSERT INTO ")
                            && self.line.ends_with(b" VALUES")
                        {
                            self.begin_insert()?;
                            return Ok(true);
                        }
                        if self.line.len() > MAX_PREAMBLE_LINE_BYTES {
                            bail!("unexpectedly long line outside an INSERT statement");
                        }
                    }
                }
            }
            self.handle_preamble_line()?;
            if at_eof {
                return Ok(false);
            }
        }
    }

    fn begin_insert(&mut self) -> Result<()> {
        let name = backticked_name(&self.line[b"INSERT INTO ".len()..])
            .ok_or_else(|| anyhow!("could not read the table name of an INSERT statement"))?;
        if name != self.table.as_bytes() {
            bail!(
                "dump inserts into `{}` but `{}` was expected",
                String::from_utf8_lossy(name),
                self.table
            );
        }
        if self.create_table.is_none() {
            bail!("INSERT into `{}` appears before its CREATE TABLE", self.table);
        }
        self.state = State::Tuples;
        Ok(())
    }

    fn handle_preamble_line(&mut self) -> Result<()> {
        let line = trim_ascii(&self.line);
        if let Some(rest) = line.strip_prefix(b"CREATE TABLE ") {
            let name = backticked_name(rest)
                .ok_or_else(|| anyhow!("could not read the table name of CREATE TABLE"))?;
            if name != self.table.as_bytes() {
                bail!(
                    "dump defines table `{}` but `{}` was expected",
                    String::from_utf8_lossy(name),
                    self.table
                );
            }
            self.create_table = Some(String::from_utf8_lossy(name).into_owned());
            self.columns.clear();
            self.in_create = true;
        } else if self.in_create {
            if line.starts_with(b"`") {
                let name = backticked_name(line)
                    .ok_or_else(|| anyhow!("could not read a column name in CREATE TABLE"))?;
                self.columns.push(String::from_utf8_lossy(name).into_owned());
            } else if line.starts_with(b")") {
                self.in_create = false;
            }
        }
        Ok(())
    }

    /// Parses one tuple; the opening parenthesis has already been consumed.
    fn read_tuple(&mut self, row: &mut Row) -> Result<()> {
        row.clear();
        loop {
            let mut b = self.must_next()?;
            while b == b' ' {
                b = self.must_next()?;
            }

            if b == b'\'' {
                let start = row.data.len();
                self.read_quoted(&mut row.data)?;
                row.fields.push(Field {
                    kind: FieldKind::Str,
                    start,
                    end: row.data.len(),
                });
                let mut terminator = self.must_next()?;
                while terminator == b' ' {
                    terminator = self.must_next()?;
                }
                match terminator {
                    b',' => continue,
                    b')' => return Ok(()),
                    other => bail!(
                        "unexpected byte {:?} after a string in `{}` row {}",
                        other as char,
                        self.table,
                        self.rows + 1
                    ),
                }
            }

            // Unquoted token: copy through to the next ',' or ')'.
            let start = row.data.len();
            let terminator = if b == b',' || b == b')' {
                b
            } else {
                row.data.push(b);
                self.read_raw(&mut row.data)?
            };
            let mut end = row.data.len();
            while end > start && row.data[end - 1] == b' ' {
                end -= 1;
            }
            row.data.truncate(end);
            let kind = if &row.data[start..end] == b"NULL" {
                FieldKind::Null
            } else {
                FieldKind::Raw
            };
            row.fields.push(Field { kind, start, end });
            if terminator == b')' {
                return Ok(());
            }
        }
    }

    /// Copies an unquoted token into `out`, returning its `,` or `)` terminator.
    #[inline]
    fn read_raw(&mut self, out: &mut Vec<u8>) -> Result<u8> {
        loop {
            if self.pos == self.len && !self.fill()? {
                bail!("unexpected end of dump inside a `{}` tuple", self.table);
            }
            let chunk = &self.buf[self.pos..self.len];
            match chunk.iter().position(|&c| c == b',' || c == b')') {
                Some(index) => {
                    out.extend_from_slice(&chunk[..index]);
                    let terminator = chunk[index];
                    self.pos += index + 1;
                    return Ok(terminator);
                }
                None => {
                    out.extend_from_slice(chunk);
                    self.pos = self.len;
                }
            }
        }
    }

    /// Decodes a quoted string into `out`; the opening quote is already consumed.
    #[inline]
    fn read_quoted(&mut self, out: &mut Vec<u8>) -> Result<()> {
        loop {
            if self.pos == self.len && !self.fill()? {
                bail!("unexpected end of dump inside a `{}` string", self.table);
            }
            let chunk = &self.buf[self.pos..self.len];
            match chunk.iter().position(|&c| c == b'\'' || c == b'\\') {
                None => {
                    out.extend_from_slice(chunk);
                    self.pos = self.len;
                }
                Some(index) => {
                    out.extend_from_slice(&chunk[..index]);
                    let special = chunk[index];
                    self.pos += index + 1;
                    if special == b'\\' {
                        let escaped = self.must_next()?;
                        out.push(unescape(escaped));
                    } else if self.peek_byte()? == Some(b'\'') {
                        // SQL-standard doubled quote.
                        self.pos += 1;
                        out.push(b'\'');
                    } else {
                        return Ok(());
                    }
                }
            }
        }
    }
}

/// MySQL string escape sequences (the character after a backslash).
#[inline]
fn unescape(escaped: u8) -> u8 {
    match escaped {
        b'0' => 0x00,
        b'b' => 0x08,
        b'n' => b'\n',
        b'r' => b'\r',
        b't' => b'\t',
        b'Z' => 0x1a,
        other => other,
    }
}

fn trim_ascii(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|b| !b.is_ascii_whitespace())
        .map_or(start, |i| i + 1);
    &bytes[start..end]
}

/// Extracts `name` from bytes beginning with `` `name` ``.
fn backticked_name(bytes: &[u8]) -> Option<&[u8]> {
    let rest = bytes.strip_prefix(b"`")?;
    let end = rest.iter().position(|&b| b == b'`')?;
    Some(&rest[..end])
}

/// Moves a blocking reader (gzip inflation) onto its own thread so that
/// decompression and SQL parsing run in parallel.
pub struct ThreadedReader {
    receiver: Receiver<io::Result<Vec<u8>>>,
    current: Vec<u8>,
    pos: usize,
    finished: bool,
    handle: Option<JoinHandle<()>>,
}

impl ThreadedReader {
    pub fn spawn<R: Read + Send + 'static>(mut inner: R) -> Self {
        let (sender, receiver) = sync_channel::<io::Result<Vec<u8>>>(8);
        let handle = thread::spawn(move || loop {
            let mut chunk = vec![0u8; READ_BUFFER_BYTES];
            let mut filled = 0;
            let mut error = None;
            // Fill the chunk fully so the parser sees large, uniform buffers.
            while filled < chunk.len() {
                match inner.read(&mut chunk[filled..]) {
                    Ok(0) => break,
                    Ok(n) => filled += n,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(e) => {
                        error = Some(e);
                        break;
                    }
                }
            }
            chunk.truncate(filled);
            let at_end = filled == 0 || error.is_some();
            if filled > 0 && sender.send(Ok(chunk)).is_err() {
                return;
            }
            if let Some(e) = error {
                let _ = sender.send(Err(e));
                return;
            }
            if at_end {
                return;
            }
        });
        ThreadedReader {
            receiver,
            current: Vec::new(),
            pos: 0,
            finished: false,
            handle: Some(handle),
        }
    }
}

impl Read for ThreadedReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        while self.pos == self.current.len() {
            if self.finished {
                return Ok(0);
            }
            match self.receiver.recv() {
                Ok(Ok(chunk)) => {
                    self.current = chunk;
                    self.pos = 0;
                }
                Ok(Err(e)) => {
                    self.finished = true;
                    return Err(e);
                }
                Err(_) => {
                    // Sender dropped: clean end of stream.
                    self.finished = true;
                    return Ok(0);
                }
            }
        }
        let n = out.len().min(self.current.len() - self.pos);
        out[..n].copy_from_slice(&self.current[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

impl Drop for ThreadedReader {
    fn drop(&mut self) {
        // Unblock a producer waiting on a full channel, then reap the thread.
        self.finished = true;
        let (_, dummy) = sync_channel::<io::Result<Vec<u8>>>(1);
        drop(std::mem::replace(&mut self.receiver, dummy));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Opens a `.sql` or `.sql.gz` dump, detecting gzip by its magic bytes.
pub fn open_dump(path: &Path, table: &str) -> Result<SqlDump<Box<dyn Read + Send>>> {
    let mut file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut magic = [0u8; 2];
    let mut read = 0;
    while read < magic.len() {
        let n = file
            .read(&mut magic[read..])
            .with_context(|| format!("reading {}", path.display()))?;
        if n == 0 {
            break;
        }
        read += n;
    }
    drop(file);

    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let reader: Box<dyn Read + Send> = if read == 2 && magic == [0x1f, 0x8b] {
        let decoder = MultiGzDecoder::new(BufReader::with_capacity(READ_BUFFER_BYTES, file));
        Box::new(ThreadedReader::spawn(decoder))
    } else {
        Box::new(file)
    };
    Ok(SqlDump::new(reader, table))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const HEADER: &str = "-- MariaDB dump\n\
        /*!40101 SET NAMES utf8mb4 */;\n\
        DROP TABLE IF EXISTS `t`;\n\
        CREATE TABLE `t` (\n\
        \x20 `id` int(8) unsigned NOT NULL,\n\
        \x20 `ns` int(11) NOT NULL DEFAULT 0,\n\
        \x20 `title` varbinary(255) NOT NULL DEFAULT '',\n\
        \x20 `extra` varbinary(32) DEFAULT NULL,\n\
        \x20 PRIMARY KEY (`id`),\n\
        \x20 KEY `ns_title` (`ns`,`title`)\n\
        ) ENGINE=InnoDB DEFAULT CHARSET=binary;\n\
        /*!40000 ALTER TABLE `t` DISABLE KEYS */;\n";

    fn parse(sql: &str) -> Vec<Vec<Option<Vec<u8>>>> {
        let mut dump = SqlDump::new(Cursor::new(sql.as_bytes().to_vec()), "t");
        let mut row = Row::new();
        let mut out = Vec::new();
        while dump.next_row(&mut row).unwrap() {
            out.push(
                (0..row.len())
                    .map(|i| row.bytes(i).unwrap().map(<[u8]>::to_vec))
                    .collect(),
            );
        }
        out
    }

    fn s(text: &str) -> Option<Vec<u8>> {
        Some(text.as_bytes().to_vec())
    }

    #[test]
    fn parses_multiline_tuples_and_columns() {
        let sql = format!(
            "{HEADER}INSERT INTO `t` VALUES\n(1,0,'A',NULL),\n(2,-1,'B_c','x');\n/*!40000 ALTER TABLE `t` ENABLE KEYS */;\n"
        );
        let mut dump = SqlDump::new(Cursor::new(sql.into_bytes()), "t");
        let mut row = Row::new();
        assert!(dump.next_row(&mut row).unwrap());
        assert_eq!(dump.columns(), ["id", "ns", "title", "extra"]);
        assert_eq!(dump.column("title").unwrap(), 2);
        assert!(dump.column("missing").is_err());
        assert_eq!(row.u64(0).unwrap(), 1);
        assert_eq!(row.bytes(2).unwrap(), Some(&b"A"[..]));
        assert!(row.is_null(3).unwrap());
        assert!(dump.next_row(&mut row).unwrap());
        assert_eq!(row.i64(1).unwrap(), -1);
        assert_eq!(row.bytes(3).unwrap(), Some(&b"x"[..]));
        assert!(!dump.next_row(&mut row).unwrap());
        assert_eq!(dump.rows_read(), 2);
    }

    #[test]
    fn parses_legacy_single_line_and_multiple_inserts() {
        let sql = format!(
            "{HEADER}INSERT INTO `t` VALUES (1,0,'A',NULL),(2,0,'B',NULL);\nINSERT INTO `t` VALUES (3,0,'C',NULL);\n"
        );
        let rows = parse(&sql);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2][0], s("3"));
        assert_eq!(rows[2][2], s("C"));
    }

    #[test]
    fn decodes_escapes() {
        let sql = format!(
            "{HEADER}INSERT INTO `t` VALUES\n(1,0,'It\\'s_a_\\\"Quote\\\"',NULL),\n(2,0,'Back\\\\slash','a\\nb\\tc\\0d\\Ze'),\n(3,0,'Doubled''quote',''),\n(4,0,'paren),(comma','x');\n"
        );
        let rows = parse(&sql);
        assert_eq!(rows[0][2], s("It's_a_\"Quote\""));
        assert_eq!(rows[1][2], s("Back\\slash"));
        assert_eq!(rows[1][3], Some(b"a\nb\tc\0d\x1ae".to_vec()));
        assert_eq!(rows[2][2], s("Doubled'quote"));
        assert_eq!(rows[2][3], s(""));
        assert_eq!(rows[3][2], s("paren),(comma"));
    }

    #[test]
    fn distinguishes_null_from_quoted_null() {
        let sql = format!("{HEADER}INSERT INTO `t` VALUES (1,0,'NULL',NULL);\n");
        let rows = parse(&sql);
        assert_eq!(rows[0][2], s("NULL"));
        assert_eq!(rows[0][3], None);
    }

    #[test]
    fn preserves_non_utf8_and_multibyte_bytes() {
        let mut sql = format!("{HEADER}INSERT INTO `t` VALUES (1,0,'Caf").into_bytes();
        sql.extend_from_slice("é".as_bytes());
        sql.extend_from_slice(b"',NULL),(2,0,'\xff\xfe',NULL);\n");
        let mut dump = SqlDump::new(Cursor::new(sql), "t");
        let mut row = Row::new();
        assert!(dump.next_row(&mut row).unwrap());
        assert_eq!(row.bytes(2).unwrap(), Some("Café".as_bytes()));
        assert!(dump.next_row(&mut row).unwrap());
        assert_eq!(row.bytes(2).unwrap(), Some(&b"\xff\xfe"[..]));
    }

    #[test]
    fn handles_values_spanning_read_buffers() {
        // A reader that returns one byte at a time exercises every refill path.
        struct OneByte(Cursor<Vec<u8>>);
        impl Read for OneByte {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                self.0.read(&mut out[..1])
            }
        }
        let sql = format!(
            "{HEADER}INSERT INTO `t` VALUES\n(10,0,'A\\'b''c',NULL),\n(11,0,'D',0.5);\n"
        );
        let mut dump = SqlDump::new(OneByte(Cursor::new(sql.into_bytes())), "t");
        let mut row = Row::new();
        assert!(dump.next_row(&mut row).unwrap());
        assert_eq!(row.bytes(2).unwrap(), Some(&b"A'b'c"[..]));
        assert!(dump.next_row(&mut row).unwrap());
        assert_eq!(row.u64(0).unwrap(), 11);
        assert_eq!(row.bytes(3).unwrap(), Some(&b"0.5"[..]));
        assert!(!dump.next_row(&mut row).unwrap());
    }

    #[test]
    fn rejects_wrong_table_and_truncation() {
        let wrong = format!("{HEADER}INSERT INTO `other` VALUES (1,0,'A',NULL);\n");
        let mut dump = SqlDump::new(Cursor::new(wrong.into_bytes()), "t");
        assert!(dump.next_row(&mut Row::new()).is_err());

        let truncated = format!("{HEADER}INSERT INTO `t` VALUES (1,0,'A");
        let mut dump = SqlDump::new(Cursor::new(truncated.into_bytes()), "t");
        assert!(dump.next_row(&mut Row::new()).is_err());

        let unterminated = format!("{HEADER}INSERT INTO `t` VALUES (1,0,'A',NULL)");
        let mut dump = SqlDump::new(Cursor::new(unterminated.into_bytes()), "t");
        let mut row = Row::new();
        assert!(dump.next_row(&mut row).unwrap());
        assert!(dump.next_row(&mut row).is_err());
    }

    #[test]
    fn integer_accessors_reject_garbage() {
        let sql = format!("{HEADER}INSERT INTO `t` VALUES (1x,-,'A',NULL);\n");
        let mut dump = SqlDump::new(Cursor::new(sql.into_bytes()), "t");
        let mut row = Row::new();
        assert!(dump.next_row(&mut row).unwrap());
        assert!(row.u64(0).is_err());
        assert!(row.i64(1).is_err());
        assert!(row.u64(3).is_err());
        assert!(row.u64(9).is_err());
    }

    #[test]
    fn threaded_reader_round_trips() {
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        let mut reader = ThreadedReader::spawn(Cursor::new(data.clone()));
        let mut out = Vec::new();
        reader.read_to_end(&mut out).unwrap();
        assert_eq!(out, data);
    }

    #[test]
    fn threaded_reader_can_be_dropped_early() {
        let data = vec![7u8; 64 << 20];
        let mut reader = ThreadedReader::spawn(Cursor::new(data));
        let mut first = [0u8; 16];
        reader.read_exact(&mut first).unwrap();
        drop(reader);
    }
}
