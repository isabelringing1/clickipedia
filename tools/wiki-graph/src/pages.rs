//! In-memory table of namespace-0 pages: article ordinals, title lookup, and
//! transitive redirect resolution.
//!
//! Titles live in one contiguous arena and the lookup table stores only page
//! indexes, which keeps ~19 million English Wikipedia titles under 1 GiB.

use std::io::Read;

use anyhow::{bail, ensure, Context, Result};
use hashbrown::HashTable;

use crate::sql::{Row, SqlDump};
use crate::util::{human_count, Progress};

/// Sentinel for "no page" / "no ordinal".
pub const NONE: u32 = u32::MAX;

pub const MAIN_NAMESPACE: i64 = 0;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RedirectStats {
    /// Namespace-0 pages flagged as redirects.
    pub redirect_pages: u32,
    /// Redirects that reach an article, possibly through other redirects.
    pub aliases: u32,
    /// Flagged as a redirect but absent from the `redirect` table.
    pub missing_row: u32,
    /// Has a row, but the target is missing, in another namespace, or on
    /// another wiki.
    pub no_usable_target: u32,
    /// Chain loops back on itself or ends at one of the cases above.
    pub unresolved_chain: u32,
}

impl RedirectStats {
    pub fn unresolved(&self) -> u32 {
        self.redirect_pages - self.aliases
    }
}

pub struct PageTable {
    page_ids: Vec<u32>,
    redirect: Vec<bool>,
    /// `len() + 1` byte offsets into `arena`.
    title_offsets: Vec<u32>,
    arena: Vec<u8>,
    lookup: Option<HashTable<u32>>,
    /// Page index to its own article ordinal (`NONE` for redirects).
    ordinal: Vec<u32>,
    /// Article ordinal to page index.
    article_pages: Vec<u32>,
    /// Page index to the page index its redirect row names.
    redirect_target: Vec<u32>,
    /// Page index to the article ordinal it finally resolves to.
    resolved: Vec<u32>,
    redirect_rows_seen: Vec<bool>,
}

/// FNV-1a 64 with a SplitMix64 finalizer. hashbrown takes control bytes from
/// the high bits, so a widened 32-bit hash would degrade lookups badly.
fn hash64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h ^= h >> 30;
    h = h.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94d0_49bb_1331_11eb);
    h ^ (h >> 31)
}

fn title_in<'a>(arena: &'a [u8], offsets: &[u32], page: u32) -> &'a [u8] {
    &arena[offsets[page as usize] as usize..offsets[page as usize + 1] as usize]
}

impl PageTable {
    /// Reads the `page` dump, keeping namespace-0 rows. Articles receive dense
    /// ordinals in ascending page-ID order.
    pub fn load<R: Read>(dump: &mut SqlDump<R>) -> Result<Self> {
        let mut table = PageTable {
            page_ids: Vec::new(),
            redirect: Vec::new(),
            title_offsets: vec![0],
            arena: Vec::new(),
            lookup: Some(HashTable::new()),
            ordinal: Vec::new(),
            article_pages: Vec::new(),
            redirect_target: Vec::new(),
            resolved: Vec::new(),
            redirect_rows_seen: Vec::new(),
        };

        let mut progress = Progress::new("page");
        let mut row = Row::new();
        let mut columns = None;
        let mut previous_id: Option<u32> = None;
        while dump.next_row(&mut row)? {
            let (c_id, c_ns, c_title, c_redirect) = match columns {
                Some(found) => found,
                None => {
                    let found = (
                        dump.column("page_id")?,
                        dump.column("page_namespace")?,
                        dump.column("page_title")?,
                        dump.column("page_is_redirect")?,
                    );
                    columns = Some(found);
                    found
                }
            };
            if dump.rows_read() & 0xffff == 0 {
                progress.tick(|| format!("{} rows", human_count(dump.rows_read())));
            }
            if row.i64(c_ns)? != MAIN_NAMESPACE {
                continue;
            }
            let id = u32::try_from(row.u64(c_id)?).context("page_id does not fit in u32")?;
            ensure!(id != NONE, "page_id {id} collides with the sentinel value");
            if let Some(previous) = previous_id {
                ensure!(
                    id > previous,
                    "page dump is not sorted by page_id ({previous} then {id})"
                );
            }
            previous_id = Some(id);
            let title = row
                .bytes(c_title)?
                .context("page_title is NULL")?;
            ensure!(!title.is_empty(), "page {id} has an empty title");
            let is_redirect = row.u64(c_redirect)? != 0;
            table.push_page(id, title, is_redirect)?;
        }
        ensure!(
            columns.is_some(),
            "page dump contained no rows; is this the right file?"
        );
        ensure!(
            !table.article_pages.is_empty(),
            "page dump contained no namespace-0 articles"
        );

        let pages = table.len();
        table.redirect_target = vec![NONE; pages];
        table.redirect_rows_seen = vec![false; pages];
        progress.done(format!(
            "{} rows, {} namespace-0 pages, {} articles",
            human_count(dump.rows_read()),
            human_count(pages as u64),
            human_count(table.article_pages.len() as u64)
        ));
        Ok(table)
    }

    fn push_page(&mut self, id: u32, title: &[u8], is_redirect: bool) -> Result<()> {
        let page = u32::try_from(self.page_ids.len()).context("too many pages")?;
        ensure!(page != NONE, "too many pages");
        let hash = hash64(title);
        let lookup = self.lookup.as_mut().expect("lookup table is present");
        let arena = &self.arena;
        let offsets = &self.title_offsets;
        if lookup
            .find(hash, |&other| title_in(arena, offsets, other) == title)
            .is_some()
        {
            bail!(
                "duplicate namespace-0 title {:?}",
                String::from_utf8_lossy(title)
            );
        }

        self.arena.extend_from_slice(title);
        let end = u32::try_from(self.arena.len()).context("title arena exceeds 4 GiB")?;
        self.title_offsets.push(end);
        self.page_ids.push(id);
        self.redirect.push(is_redirect);
        if is_redirect {
            self.ordinal.push(NONE);
        } else {
            let ordinal = u32::try_from(self.article_pages.len()).context("too many articles")?;
            self.ordinal.push(ordinal);
            self.article_pages.push(page);
        }

        let arena = &self.arena;
        let offsets = &self.title_offsets;
        self.lookup
            .as_mut()
            .expect("lookup table is present")
            .insert_unique(hash, page, |&other| hash64(title_in(arena, offsets, other)));
        Ok(())
    }

    /// Number of namespace-0 pages (articles plus redirects).
    pub fn len(&self) -> usize {
        self.page_ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.page_ids.is_empty()
    }

    pub fn article_count(&self) -> u32 {
        self.article_pages.len() as u32
    }

    pub fn max_page_id(&self) -> u32 {
        self.page_ids.last().copied().unwrap_or(0)
    }

    pub fn title(&self, page: u32) -> &[u8] {
        title_in(&self.arena, &self.title_offsets, page)
    }

    pub fn page_id(&self, page: u32) -> u32 {
        self.page_ids[page as usize]
    }

    pub fn is_redirect(&self, page: u32) -> bool {
        self.redirect[page as usize]
    }

    /// Page index of the article with this ordinal.
    pub fn article_page(&self, ordinal: u32) -> u32 {
        self.article_pages[ordinal as usize]
    }

    pub fn article_title(&self, ordinal: u32) -> &[u8] {
        self.title(self.article_page(ordinal))
    }

    /// The page's own ordinal; `NONE` unless the page is an article.
    pub fn own_ordinal(&self, page: u32) -> u32 {
        self.ordinal[page as usize]
    }

    /// Article ordinal the page resolves to, following redirects; `NONE` when
    /// unresolved. Only meaningful after [`PageTable::resolve_redirects`].
    pub fn resolved_ordinal(&self, page: u32) -> u32 {
        self.resolved[page as usize]
    }

    /// Exact-title lookup among namespace-0 pages.
    pub fn find(&self, title: &[u8]) -> Option<u32> {
        let lookup = self
            .lookup
            .as_ref()
            .expect("title lookup was already released");
        lookup
            .find(hash64(title), |&other| self.title(other) == title)
            .copied()
    }

    pub fn find_by_page_id(&self, id: u32) -> Option<u32> {
        self.page_ids.binary_search(&id).ok().map(|i| i as u32)
    }

    /// Frees the title hash table once no more lookups are needed.
    pub fn release_lookup(&mut self) {
        self.lookup = None;
    }

    /// Reads the `redirect` dump and records each namespace-0 redirect's
    /// immediate target.
    pub fn load_redirects<R: Read>(&mut self, dump: &mut SqlDump<R>) -> Result<()> {
        let mut progress = Progress::new("redirect");
        let mut row = Row::new();
        let mut columns = None;
        while dump.next_row(&mut row)? {
            let (c_from, c_ns, c_title, c_interwiki) = match columns {
                Some(found) => found,
                None => {
                    let found = (
                        dump.column("rd_from")?,
                        dump.column("rd_namespace")?,
                        dump.column("rd_title")?,
                        dump.column("rd_interwiki")?,
                    );
                    columns = Some(found);
                    found
                }
            };
            if dump.rows_read() & 0xffff == 0 {
                progress.tick(|| format!("{} rows", human_count(dump.rows_read())));
            }
            let Ok(from) = u32::try_from(row.u64(c_from)?) else {
                continue;
            };
            let Some(page) = self.find_by_page_id(from) else {
                continue; // not a namespace-0 page
            };
            if !self.redirect[page as usize] {
                continue; // stale row for a page that is no longer a redirect
            }
            self.redirect_rows_seen[page as usize] = true;
            let interwiki = row.bytes(c_interwiki)?.unwrap_or(b"");
            if row.i64(c_ns)? != MAIN_NAMESPACE || !interwiki.is_empty() {
                continue;
            }
            let title = row.bytes(c_title)?.context("rd_title is NULL")?;
            if let Some(target) = self.find(title) {
                self.redirect_target[page as usize] = target;
            }
        }
        progress.done(format!("{} rows", human_count(dump.rows_read())));
        Ok(())
    }

    /// Follows redirect chains to their final article. Chains that loop, dead
    /// end, or leave namespace 0 stay unresolved and are not lookup aliases.
    pub fn resolve_redirects(&mut self) -> RedirectStats {
        const UNKNOWN: u8 = 0;
        const ON_PATH: u8 = 1;
        const FINAL: u8 = 2;

        let pages = self.len();
        self.resolved = vec![NONE; pages];
        let mut state = vec![UNKNOWN; pages];
        let mut path: Vec<u32> = Vec::new();

        for start in 0..pages {
            if state[start] == FINAL {
                continue;
            }
            path.clear();
            let mut current = start;
            let result = loop {
                if state[current] == FINAL {
                    break self.resolved[current];
                }
                if state[current] == ON_PATH {
                    break NONE; // redirect loop
                }
                if !self.redirect[current] {
                    self.resolved[current] = self.ordinal[current];
                    state[current] = FINAL;
                    break self.ordinal[current];
                }
                state[current] = ON_PATH;
                path.push(current as u32);
                let next = self.redirect_target[current];
                if next == NONE {
                    break NONE;
                }
                current = next as usize;
            };
            for &page in &path {
                self.resolved[page as usize] = result;
                state[page as usize] = FINAL;
            }
        }

        let mut stats = RedirectStats::default();
        for page in 0..pages {
            if !self.redirect[page] {
                continue;
            }
            stats.redirect_pages += 1;
            if self.resolved[page] != NONE {
                stats.aliases += 1;
            } else if !self.redirect_rows_seen[page] {
                stats.missing_row += 1;
            } else if self.redirect_target[page] == NONE {
                stats.no_usable_target += 1;
            } else {
                stats.unresolved_chain += 1;
            }
        }
        stats
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn page_dump(rows: &[(u32, i32, &str, u8)]) -> SqlDump<Cursor<Vec<u8>>> {
        let mut sql = String::from(
            "CREATE TABLE `page` (\n  `page_id` int(8) unsigned NOT NULL,\n  `page_namespace` int(11) NOT NULL,\n  `page_title` varbinary(255) NOT NULL,\n  `page_is_redirect` tinyint(1) unsigned NOT NULL,\n  PRIMARY KEY (`page_id`)\n) ENGINE=InnoDB;\nINSERT INTO `page` VALUES\n",
        );
        let tuples: Vec<String> = rows
            .iter()
            .map(|(id, ns, title, redirect)| format!("({id},{ns},'{title}',{redirect})"))
            .collect();
        sql.push_str(&tuples.join(",\n"));
        sql.push_str(";\n");
        SqlDump::new(Cursor::new(sql.into_bytes()), "page")
    }

    fn redirect_dump(rows: &[(u32, i32, &str, &str)]) -> SqlDump<Cursor<Vec<u8>>> {
        let mut sql = String::from(
            "CREATE TABLE `redirect` (\n  `rd_from` int(8) unsigned NOT NULL,\n  `rd_namespace` int(11) NOT NULL,\n  `rd_title` varbinary(255) NOT NULL,\n  `rd_interwiki` varbinary(32) DEFAULT NULL,\n  `rd_fragment` varbinary(255) DEFAULT NULL,\n  PRIMARY KEY (`rd_from`)\n) ENGINE=InnoDB;\nINSERT INTO `redirect` VALUES\n",
        );
        let tuples: Vec<String> = rows
            .iter()
            .map(|(from, ns, title, interwiki)| format!("({from},{ns},'{title}','{interwiki}','')"))
            .collect();
        sql.push_str(&tuples.join(",\n"));
        sql.push_str(";\n");
        SqlDump::new(Cursor::new(sql.into_bytes()), "redirect")
    }

    fn resolved_title(table: &PageTable, title: &str) -> Option<String> {
        let page = table.find(title.as_bytes())?;
        let ordinal = table.resolved_ordinal(page);
        (ordinal != NONE)
            .then(|| String::from_utf8(table.article_title(ordinal).to_vec()).unwrap())
    }

    #[test]
    fn assigns_dense_ordinals_to_main_namespace_articles() {
        let table = PageTable::load(&mut page_dump(&[
            (5, 0, "A", 0),
            (6, 1, "A", 0),
            (7, 0, "R", 1),
            (9, 0, "B", 0),
            (12, 14, "Cat", 0),
        ]))
        .unwrap();
        assert_eq!(table.len(), 3);
        assert_eq!(table.article_count(), 2);
        assert_eq!(table.article_title(0), b"A");
        assert_eq!(table.article_title(1), b"B");
        assert_eq!(table.page_id(table.article_page(1)), 9);
        assert_eq!(table.own_ordinal(table.find(b"R").unwrap()), NONE);
        assert_eq!(table.find(b"Cat"), None);
        assert_eq!(table.find_by_page_id(6), None);
        assert_eq!(table.max_page_id(), 9);
    }

    #[test]
    fn rejects_unsorted_and_duplicate_pages() {
        assert!(PageTable::load(&mut page_dump(&[(5, 0, "A", 0), (4, 0, "B", 0)])).is_err());
        assert!(PageTable::load(&mut page_dump(&[(5, 0, "A", 0), (6, 0, "A", 0)])).is_err());
        assert!(PageTable::load(&mut page_dump(&[(5, 1, "Talk_only", 0)])).is_err());
    }

    #[test]
    fn resolves_chains_and_rejects_cycles() {
        let mut table = PageTable::load(&mut page_dump(&[
            (1, 0, "Target", 0),
            (2, 0, "One_hop", 1),
            (3, 0, "Two_hops", 1),
            (4, 0, "Three_hops", 1),
            (5, 0, "Loop_a", 1),
            (6, 0, "Loop_b", 1),
            (7, 0, "Into_loop", 1),
            (8, 0, "Self", 1),
            (9, 0, "Dangling", 1),
            (10, 0, "Leaves_namespace", 1),
            (11, 0, "Interwiki", 1),
            (12, 0, "No_row", 1),
            (13, 0, "Other", 0),
        ]))
        .unwrap();
        table
            .load_redirects(&mut redirect_dump(&[
                (2, 0, "Target", ""),
                (3, 0, "One_hop", ""),
                (4, 0, "Two_hops", ""),
                (5, 0, "Loop_b", ""),
                (6, 0, "Loop_a", ""),
                (7, 0, "Loop_a", ""),
                (8, 0, "Self", ""),
                (9, 0, "Does_not_exist", ""),
                (10, 1, "Target", ""),
                (11, 0, "Target", "fr"),
                (13, 0, "Target", ""), // stale row: page 13 is an article
                (99, 0, "Target", ""), // page is not in namespace 0
            ]))
            .unwrap();
        let stats = table.resolve_redirects();

        for alias in ["One_hop", "Two_hops", "Three_hops"] {
            assert_eq!(resolved_title(&table, alias).as_deref(), Some("Target"));
        }
        for broken in [
            "Loop_a",
            "Loop_b",
            "Into_loop",
            "Self",
            "Dangling",
            "Leaves_namespace",
            "Interwiki",
            "No_row",
        ] {
            assert_eq!(resolved_title(&table, broken), None, "{broken}");
        }
        assert_eq!(resolved_title(&table, "Target").as_deref(), Some("Target"));
        assert_eq!(resolved_title(&table, "Other").as_deref(), Some("Other"));

        assert_eq!(stats.redirect_pages, 11);
        assert_eq!(stats.aliases, 3);
        assert_eq!(stats.unresolved(), 8);
        assert_eq!(stats.missing_row, 1);
        // Dangling, Leaves_namespace, Interwiki.
        assert_eq!(stats.no_usable_target, 3);
        // Loop_a, Loop_b, Into_loop, Self.
        assert_eq!(stats.unresolved_chain, 4);
    }

    #[test]
    fn long_chains_resolve_without_recursion() {
        let count = 50_000u32;
        let mut pages = vec![(1u32, 0i32, "T".to_string(), 0u8)];
        let mut redirects = Vec::new();
        for i in 0..count {
            pages.push((i + 2, 0, format!("R{i}"), 1));
            let target = if i == 0 { "T".to_string() } else { format!("R{}", i - 1) };
            redirects.push((i + 2, 0, target, String::new()));
        }
        let page_rows: Vec<(u32, i32, &str, u8)> =
            pages.iter().map(|(a, b, c, d)| (*a, *b, c.as_str(), *d)).collect();
        let redirect_rows: Vec<(u32, i32, &str, &str)> = redirects
            .iter()
            .map(|(a, b, c, d)| (*a, *b, c.as_str(), d.as_str()))
            .collect();
        let mut table = PageTable::load(&mut page_dump(&page_rows)).unwrap();
        table.load_redirects(&mut redirect_dump(&redirect_rows)).unwrap();
        let stats = table.resolve_redirects();
        assert_eq!(stats.aliases, count);
        assert_eq!(
            resolved_title(&table, &format!("R{}", count - 1)).as_deref(),
            Some("T")
        );
    }
}
