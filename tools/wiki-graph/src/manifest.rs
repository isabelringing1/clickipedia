//! JSON documents: the locked source manifest, the immutable snapshot
//! manifest, and the mutable `latest.json` pointer.
//!
//! Snapshot manifests contain no timestamps or machine-specific paths, so
//! rebuilding the same dump with the same options is byte-for-byte identical.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const MANIFEST_FILE: &str = "manifest.json";
pub const LATEST_FILE: &str = "latest.json";
pub const SNAPSHOTS_DIR: &str = "snapshots";

/// The four tables the builder needs, in processing order.
pub const TABLES: [&str; 4] = ["page", "redirect", "linktarget", "pagelinks"];

/// Exact inputs for one snapshot, written by `resolve` and committed to Git.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceLock {
    pub schema_version: u32,
    pub wiki: String,
    pub dump_date: String,
    /// Keyed by table name.
    pub files: BTreeMap<String, SourceFile>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    pub file: String,
    pub url: String,
    pub bytes: u64,
    pub sha1: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub md5: Option<String>,
}

impl SourceLock {
    pub fn load(path: &Path) -> Result<Self> {
        let text = fs::read_to_string(path)
            .with_context(|| format!("reading source lock {}", path.display()))?;
        let lock: SourceLock = serde_json::from_str(&text)
            .with_context(|| format!("parsing source lock {}", path.display()))?;
        lock.validate()?;
        Ok(lock)
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == SCHEMA_VERSION,
            "unsupported source lock schema version {}",
            self.schema_version
        );
        ensure!(
            is_dump_date(&self.dump_date),
            "dump date {:?} is not YYYYMMDD",
            self.dump_date
        );
        for table in TABLES {
            let file = self
                .files
                .get(table)
                .with_context(|| format!("source lock has no `{table}` file"))?;
            ensure!(
                file.sha1.len() == 40 && file.sha1.bytes().all(|b| b.is_ascii_hexdigit()),
                "`{table}` has a malformed SHA-1"
            );
            ensure!(
                !file.file.contains('/') && !file.file.contains(".."),
                "`{table}` file name must be a bare file name"
            );
        }
        Ok(())
    }

    pub fn file(&self, table: &str) -> &SourceFile {
        &self.files[table]
    }
}

pub fn is_dump_date(value: &str) -> bool {
    value.len() == 8 && value.bytes().all(|b| b.is_ascii_digit())
}

/// Snapshot IDs become URL path segments, so keep them boring.
pub fn is_snapshot_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Generator {
    pub name: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSource {
    pub table: String,
    pub file: String,
    pub bytes: u64,
    pub sha1: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    /// Namespace-0 pages that are not redirects.
    pub articles: u32,
    /// Unique article-to-article links after redirect resolution.
    pub edges: u64,
    /// Namespace-0 redirects that resolve to an article (lookup aliases).
    pub redirect_aliases: u32,
    /// Namespace-0 redirects that are broken, cyclic, or leave the namespace.
    pub unresolved_redirects: u32,
    /// `articles + redirect_aliases`: entries in the title index.
    pub title_entries: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartArticle {
    pub title: String,
    pub ordinal: u32,
}

/// Fixed source-range shards: shard `i` covers ordinals
/// `[i * shard_size, min((i + 1) * shard_size, articles))`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RangeShards {
    pub dir: String,
    pub shard_size: u32,
    pub shard_count: u32,
    pub index: FileRef,
}

/// Hash-partitioned title buckets: a normalized title lives in bucket
/// `hash(title) % bucket_count`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TitleBuckets {
    pub dir: String,
    pub bucket_count: u32,
    pub hash: String,
    pub index: FileRef,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub snapshot_id: String,
    pub wiki: String,
    pub dump_date: String,
    pub generator: Generator,
    pub sources: Vec<ManifestSource>,
    pub counts: Counts,
    pub start_article: StartArticle,
    pub adjacency: RangeShards,
    pub metadata: RangeShards,
    pub titles: TitleBuckets,
    /// Keyed by report name; paths are relative to the snapshot directory.
    pub reports: BTreeMap<String, FileRef>,
}

impl Manifest {
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        to_pretty_json(self)
    }

    pub fn load(snapshot_dir: &Path) -> Result<(Self, Vec<u8>)> {
        let path = snapshot_dir.join(MANIFEST_FILE);
        let bytes = fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
        let manifest: Manifest = serde_json::from_slice(&bytes)
            .with_context(|| format!("parsing {}", path.display()))?;
        ensure!(
            manifest.schema_version == SCHEMA_VERSION,
            "unsupported manifest schema version {}",
            manifest.schema_version
        );
        Ok((manifest, bytes))
    }
}

/// Mutable pointer selecting the snapshot that new saves start on.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    pub schema_version: u32,
    pub snapshot_id: String,
    pub manifest_path: String,
    pub manifest_sha256: String,
}

pub fn snapshot_manifest_path(snapshot_id: &str) -> String {
    format!("{SNAPSHOTS_DIR}/{snapshot_id}/{MANIFEST_FILE}")
}

/// Pretty JSON with a trailing newline; struct field order keeps it stable.
pub fn to_pretty_json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value).context("serializing JSON")?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ids_and_dates() {
        assert!(is_dump_date("20261001"));
        assert!(!is_dump_date("2026-10-01"));
        assert!(!is_dump_date("latest"));
        assert!(is_snapshot_id("20261001"));
        assert!(is_snapshot_id("20261001-r2"));
        assert!(!is_snapshot_id("../etc"));
        assert!(!is_snapshot_id(""));
        assert!(!is_snapshot_id("a/b"));
    }

    #[test]
    fn source_lock_requires_all_tables_and_sane_names() {
        let file = |name: &str| SourceFile {
            file: name.to_string(),
            url: format!("https://example.org/{name}"),
            bytes: 1,
            sha1: "a".repeat(40),
            md5: None,
        };
        let mut lock = SourceLock {
            schema_version: SCHEMA_VERSION,
            wiki: "enwiki".into(),
            dump_date: "20261001".into(),
            files: TABLES
                .iter()
                .map(|t| (t.to_string(), file(&format!("{t}.sql.gz"))))
                .collect(),
        };
        lock.validate().unwrap();

        lock.files.get_mut("page").unwrap().file = "../page.sql.gz".into();
        assert!(lock.validate().is_err());
        lock.files.get_mut("page").unwrap().file = "page.sql.gz".into();

        lock.files.get_mut("page").unwrap().sha1 = "xyz".into();
        assert!(lock.validate().is_err());
        lock.files.get_mut("page").unwrap().sha1 = "b".repeat(40);

        lock.files.remove("redirect");
        assert!(lock.validate().is_err());
    }

    #[test]
    fn manifest_json_uses_camel_case() {
        let latest = Latest {
            schema_version: 1,
            snapshot_id: "20261001".into(),
            manifest_path: snapshot_manifest_path("20261001"),
            manifest_sha256: "00".repeat(32),
        };
        let text = String::from_utf8(to_pretty_json(&latest).unwrap()).unwrap();
        assert!(text.contains("\"snapshotId\": \"20261001\""));
        assert!(text.contains("\"manifestPath\": \"snapshots/20261001/manifest.json\""));
        assert!(text.ends_with("}\n"));
    }
}
