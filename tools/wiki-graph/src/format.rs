//! Binary shard formats (schema version 1).
//!
//! Every file starts with a 16-byte header of four little-endian `u32` words,
//! and every integer array that follows is little-endian `u32`, so a browser
//! can view the arrays in place with `Uint32Array`. The decoders here are
//! mirrored by `src/wikiGraph/codec.js`.
//!
//! ```text
//! adjacency shard  "CKAJ" version first_ordinal count
//!                  offsets[count + 1]            index into `targets`
//!                  targets[offsets[count]]       ascending within each source
//!
//! metadata shard   "CKMD" version first_ordinal count
//!                  page_ids[count]
//!                  title_offsets[count + 1]      byte offsets into `titles`
//!                  titles                        UTF-8, database-key form
//!
//! title bucket     "CKTB" version bucket count
//!                  ordinals[count]
//!                  title_offsets[count + 1]
//!                  flags[count]                  bit 0: entry is a redirect alias
//!                  titles                        sorted bytewise, unique
//!
//! shard index      "CKIX" version kind count
//!                  count * { bytes: u32, sha256: [u8; 32] }
//! ```

use anyhow::{bail, ensure, Result};

pub const FORMAT_VERSION: u32 = 1;

pub const MAGIC_ADJACENCY: [u8; 4] = *b"CKAJ";
pub const MAGIC_METADATA: [u8; 4] = *b"CKMD";
pub const MAGIC_TITLES: [u8; 4] = *b"CKTB";
pub const MAGIC_INDEX: [u8; 4] = *b"CKIX";

pub const HEADER_BYTES: usize = 16;
pub const INDEX_ENTRY_BYTES: usize = 36;

pub const DIR_ADJACENCY: &str = "adjacency";
pub const DIR_METADATA: &str = "metadata";
pub const DIR_TITLES: &str = "titles";
pub const INDEX_FILE: &str = "index.bin";

pub const KIND_ADJACENCY: u32 = 1;
pub const KIND_METADATA: u32 = 2;
pub const KIND_TITLES: u32 = 3;

pub const TITLE_FLAG_REDIRECT: u8 = 1;

/// Relative path of shard `index` inside a snapshot, e.g. `adjacency/000042.bin`.
pub fn shard_path(dir: &str, index: u32) -> String {
    format!("{dir}/{index:06}.bin")
}

pub fn index_path(dir: &str) -> String {
    format!("{dir}/{INDEX_FILE}")
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32_slice(out: &mut Vec<u8>, values: &[u32]) {
    out.reserve(values.len() * 4);
    for &value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
}

fn write_header(out: &mut Vec<u8>, magic: [u8; 4], a: u32, b: u32) {
    out.extend_from_slice(&magic);
    push_u32(out, FORMAT_VERSION);
    push_u32(out, a);
    push_u32(out, b);
}

/// Validates the header and returns the two format-specific words.
fn read_header(bytes: &[u8], magic: [u8; 4], what: &str) -> Result<(u32, u32)> {
    ensure!(
        bytes.len() >= HEADER_BYTES,
        "{what}: {} bytes is too short for a header",
        bytes.len()
    );
    ensure!(bytes[..4] == magic, "{what}: bad magic bytes");
    let version = u32_at(bytes, 4);
    ensure!(
        version == FORMAT_VERSION,
        "{what}: unsupported format version {version}"
    );
    Ok((u32_at(bytes, 8), u32_at(bytes, 12)))
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn read_u32_slice(bytes: &[u8], offset: usize, count: usize) -> Vec<u32> {
    bytes[offset..offset + count * 4]
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()))
        .collect()
}

/// Checks that `offsets` starts at zero, never decreases, and ends at `total`.
fn check_offsets(offsets: &[u32], total: usize, what: &str) -> Result<()> {
    ensure!(
        offsets.first() == Some(&0),
        "{what}: offsets must start at zero"
    );
    ensure!(
        offsets.windows(2).all(|pair| pair[0] <= pair[1]),
        "{what}: offsets must not decrease"
    );
    ensure!(
        *offsets.last().unwrap() as usize == total,
        "{what}: final offset {} does not match payload length {total}",
        offsets.last().unwrap()
    );
    Ok(())
}

/// Out-links for a contiguous range of source ordinals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdjacencyShard {
    pub first_ordinal: u32,
    /// `count + 1` entries indexing into `targets`.
    pub offsets: Vec<u32>,
    pub targets: Vec<u32>,
}

impl AdjacencyShard {
    pub fn count(&self) -> u32 {
        (self.offsets.len() - 1) as u32
    }

    pub fn neighbors(&self, local_index: usize) -> &[u32] {
        &self.targets[self.offsets[local_index] as usize..self.offsets[local_index + 1] as usize]
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out =
            Vec::with_capacity(HEADER_BYTES + (self.offsets.len() + self.targets.len()) * 4);
        write_header(&mut out, MAGIC_ADJACENCY, self.first_ordinal, self.count());
        push_u32_slice(&mut out, &self.offsets);
        push_u32_slice(&mut out, &self.targets);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let what = "adjacency shard";
        let (first_ordinal, count) = read_header(bytes, MAGIC_ADJACENCY, what)?;
        let count = count as usize;
        let offsets_end = HEADER_BYTES
            .checked_add((count + 1).checked_mul(4).unwrap_or(usize::MAX))
            .unwrap_or(usize::MAX);
        ensure!(bytes.len() >= offsets_end, "{what}: truncated offsets");
        let offsets = read_u32_slice(bytes, HEADER_BYTES, count + 1);
        let payload = bytes.len() - offsets_end;
        ensure!(payload % 4 == 0, "{what}: target bytes are not a multiple of 4");
        check_offsets(&offsets, payload / 4, what)?;
        let targets = read_u32_slice(bytes, offsets_end, payload / 4);
        Ok(AdjacencyShard {
            first_ordinal,
            offsets,
            targets,
        })
    }
}

/// Page IDs and titles for a contiguous range of article ordinals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataShard {
    pub first_ordinal: u32,
    pub page_ids: Vec<u32>,
    /// `count + 1` byte offsets into `titles`.
    pub title_offsets: Vec<u32>,
    pub titles: Vec<u8>,
}

impl MetadataShard {
    pub fn count(&self) -> u32 {
        self.page_ids.len() as u32
    }

    pub fn title(&self, local_index: usize) -> &[u8] {
        &self.titles
            [self.title_offsets[local_index] as usize..self.title_offsets[local_index + 1] as usize]
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            HEADER_BYTES + (self.page_ids.len() + self.title_offsets.len()) * 4 + self.titles.len(),
        );
        write_header(&mut out, MAGIC_METADATA, self.first_ordinal, self.count());
        push_u32_slice(&mut out, &self.page_ids);
        push_u32_slice(&mut out, &self.title_offsets);
        out.extend_from_slice(&self.titles);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let what = "metadata shard";
        let (first_ordinal, count) = read_header(bytes, MAGIC_METADATA, what)?;
        let count = count as usize;
        let fixed = (count as u64) * 4 + (count as u64 + 1) * 4;
        ensure!(
            (bytes.len() as u64) >= HEADER_BYTES as u64 + fixed,
            "{what}: truncated arrays"
        );
        let page_ids = read_u32_slice(bytes, HEADER_BYTES, count);
        let offsets_start = HEADER_BYTES + count * 4;
        let title_offsets = read_u32_slice(bytes, offsets_start, count + 1);
        let titles_start = offsets_start + (count + 1) * 4;
        let titles = bytes[titles_start..].to_vec();
        check_offsets(&title_offsets, titles.len(), what)?;
        Ok(MetadataShard {
            first_ordinal,
            page_ids,
            title_offsets,
            titles,
        })
    }
}

/// One hash partition of the title index (articles plus redirect aliases).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TitleBucket {
    pub bucket: u32,
    pub ordinals: Vec<u32>,
    /// `count + 1` byte offsets into `titles`.
    pub title_offsets: Vec<u32>,
    pub flags: Vec<u8>,
    pub titles: Vec<u8>,
}

impl TitleBucket {
    pub fn count(&self) -> u32 {
        self.ordinals.len() as u32
    }

    pub fn title(&self, index: usize) -> &[u8] {
        &self.titles[self.title_offsets[index] as usize..self.title_offsets[index + 1] as usize]
    }

    /// Binary search for an exact title; returns `(ordinal, flags)`.
    pub fn lookup(&self, title: &[u8]) -> Option<(u32, u8)> {
        let mut low = 0usize;
        let mut high = self.ordinals.len();
        while low < high {
            let mid = low + (high - low) / 2;
            match self.title(mid).cmp(title) {
                std::cmp::Ordering::Less => low = mid + 1,
                std::cmp::Ordering::Greater => high = mid,
                std::cmp::Ordering::Equal => return Some((self.ordinals[mid], self.flags[mid])),
            }
        }
        None
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            HEADER_BYTES
                + (self.ordinals.len() + self.title_offsets.len()) * 4
                + self.flags.len()
                + self.titles.len(),
        );
        write_header(&mut out, MAGIC_TITLES, self.bucket, self.count());
        push_u32_slice(&mut out, &self.ordinals);
        push_u32_slice(&mut out, &self.title_offsets);
        out.extend_from_slice(&self.flags);
        out.extend_from_slice(&self.titles);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let what = "title bucket";
        let (bucket, count) = read_header(bytes, MAGIC_TITLES, what)?;
        let count = count as usize;
        let fixed = (count as u64) * 4 + (count as u64 + 1) * 4 + count as u64;
        ensure!(
            (bytes.len() as u64) >= HEADER_BYTES as u64 + fixed,
            "{what}: truncated arrays"
        );
        let ordinals = read_u32_slice(bytes, HEADER_BYTES, count);
        let offsets_start = HEADER_BYTES + count * 4;
        let title_offsets = read_u32_slice(bytes, offsets_start, count + 1);
        let flags_start = offsets_start + (count + 1) * 4;
        let flags = bytes[flags_start..flags_start + count].to_vec();
        let titles = bytes[flags_start + count..].to_vec();
        check_offsets(&title_offsets, titles.len(), what)?;
        let decoded = TitleBucket {
            bucket,
            ordinals,
            title_offsets,
            flags,
            titles,
        };
        for index in 1..count {
            if decoded.title(index - 1) >= decoded.title(index) {
                bail!("{what}: titles are not strictly ascending at entry {index}");
            }
        }
        Ok(decoded)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexEntry {
    pub bytes: u32,
    pub sha256: [u8; 32],
}

/// Byte length and SHA-256 of every shard of one kind, in shard order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardIndex {
    pub kind: u32,
    pub entries: Vec<IndexEntry>,
}

impl ShardIndex {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_BYTES + self.entries.len() * INDEX_ENTRY_BYTES);
        write_header(&mut out, MAGIC_INDEX, self.kind, self.entries.len() as u32);
        for entry in &self.entries {
            push_u32(&mut out, entry.bytes);
            out.extend_from_slice(&entry.sha256);
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let what = "shard index";
        let (kind, count) = read_header(bytes, MAGIC_INDEX, what)?;
        let expected = HEADER_BYTES as u64 + count as u64 * INDEX_ENTRY_BYTES as u64;
        ensure!(
            bytes.len() as u64 == expected,
            "{what}: expected {expected} bytes for {count} entries, found {}",
            bytes.len()
        );
        let entries = bytes[HEADER_BYTES..]
            .chunks_exact(INDEX_ENTRY_BYTES)
            .map(|chunk| IndexEntry {
                bytes: u32_at(chunk, 0),
                sha256: chunk[4..].try_into().unwrap(),
            })
            .collect();
        Ok(ShardIndex { kind, entries })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_adjacency() -> AdjacencyShard {
        AdjacencyShard {
            first_ordinal: 8,
            offsets: vec![0, 2, 2, 5],
            targets: vec![1, 9, 0, 3, 4_000_000_000],
        }
    }

    #[test]
    fn adjacency_round_trip_and_layout() {
        let shard = sample_adjacency();
        let bytes = shard.encode();
        assert_eq!(&bytes[..4], b"CKAJ");
        assert_eq!(bytes.len(), 16 + 4 * 4 + 5 * 4);
        // first_ordinal and count are little-endian words 2 and 3.
        assert_eq!(&bytes[8..16], &[8, 0, 0, 0, 3, 0, 0, 0]);
        let decoded = AdjacencyShard::decode(&bytes).unwrap();
        assert_eq!(decoded, shard);
        assert_eq!(decoded.neighbors(0), &[1, 9]);
        assert!(decoded.neighbors(1).is_empty());
        assert_eq!(decoded.neighbors(2), &[0, 3, 4_000_000_000]);
    }

    #[test]
    fn adjacency_rejects_corruption() {
        let bytes = sample_adjacency().encode();
        assert!(AdjacencyShard::decode(&bytes[..bytes.len() - 4]).is_err());
        assert!(AdjacencyShard::decode(&bytes[..bytes.len() - 1]).is_err());
        assert!(AdjacencyShard::decode(&bytes[..10]).is_err());

        let mut bad_magic = bytes.clone();
        bad_magic[0] = b'X';
        assert!(AdjacencyShard::decode(&bad_magic).is_err());

        let mut bad_version = bytes.clone();
        bad_version[4] = 2;
        assert!(AdjacencyShard::decode(&bad_version).is_err());

        let mut decreasing = bytes.clone();
        decreasing[16 + 4] = 3; // offsets become [0, 3, 2, 5]
        assert!(AdjacencyShard::decode(&decreasing).is_err());

        let mut extra = bytes.clone();
        extra.extend_from_slice(&[0, 0, 0, 0]);
        assert!(AdjacencyShard::decode(&extra).is_err());
    }

    #[test]
    fn empty_adjacency_shard_round_trips() {
        let shard = AdjacencyShard {
            first_ordinal: 0,
            offsets: vec![0, 0, 0],
            targets: vec![],
        };
        assert_eq!(AdjacencyShard::decode(&shard.encode()).unwrap(), shard);
    }

    #[test]
    fn metadata_round_trip() {
        let shard = MetadataShard {
            first_ordinal: 3,
            page_ids: vec![11, 12, 16],
            title_offsets: vec![0, 6, 11, 16],
            titles: "OrphanCaféDead_".as_bytes()[..16].to_vec(),
        };
        let bytes = shard.encode();
        let decoded = MetadataShard::decode(&bytes).unwrap();
        assert_eq!(decoded, shard);
        assert_eq!(decoded.title(0), b"Orphan");
        assert_eq!(decoded.title(1), "Café".as_bytes());
        assert!(MetadataShard::decode(&bytes[..bytes.len() - 1]).is_err());
    }

    #[test]
    fn title_bucket_round_trip_and_lookup() {
        let bucket = TitleBucket {
            bucket: 2,
            ordinals: vec![5, 1, 9],
            title_offsets: vec![0, 1, 3, 6],
            flags: vec![0, TITLE_FLAG_REDIRECT, 0],
            titles: b"ABbCcc".to_vec(),
        };
        let bytes = bucket.encode();
        let decoded = TitleBucket::decode(&bytes).unwrap();
        assert_eq!(decoded, bucket);
        assert_eq!(decoded.lookup(b"A"), Some((5, 0)));
        assert_eq!(decoded.lookup(b"Bb"), Some((1, TITLE_FLAG_REDIRECT)));
        assert_eq!(decoded.lookup(b"Ccc"), Some((9, 0)));
        assert_eq!(decoded.lookup(b"B"), None);
        assert_eq!(decoded.lookup(b""), None);
        assert_eq!(decoded.lookup(b"Zzz"), None);
    }

    #[test]
    fn title_bucket_rejects_unsorted_titles() {
        let bucket = TitleBucket {
            bucket: 0,
            ordinals: vec![1, 2],
            title_offsets: vec![0, 1, 2],
            flags: vec![0, 0],
            titles: b"BA".to_vec(),
        };
        assert!(TitleBucket::decode(&bucket.encode()).is_err());
    }

    #[test]
    fn empty_title_bucket_round_trips() {
        let bucket = TitleBucket {
            bucket: 7,
            ordinals: vec![],
            title_offsets: vec![0],
            flags: vec![],
            titles: vec![],
        };
        let decoded = TitleBucket::decode(&bucket.encode()).unwrap();
        assert_eq!(decoded, bucket);
        assert_eq!(decoded.lookup(b"A"), None);
    }

    #[test]
    fn index_round_trip() {
        let index = ShardIndex {
            kind: KIND_TITLES,
            entries: vec![
                IndexEntry {
                    bytes: 100,
                    sha256: [1; 32],
                },
                IndexEntry {
                    bytes: 7,
                    sha256: [2; 32],
                },
            ],
        };
        let bytes = index.encode();
        assert_eq!(bytes.len(), 16 + 2 * 36);
        assert_eq!(ShardIndex::decode(&bytes).unwrap(), index);
        assert!(ShardIndex::decode(&bytes[..bytes.len() - 1]).is_err());
    }

    #[test]
    fn shard_paths_are_zero_padded() {
        assert_eq!(shard_path(DIR_ADJACENCY, 42), "adjacency/000042.bin");
        assert_eq!(index_path(DIR_TITLES), "titles/index.bin");
    }
}
