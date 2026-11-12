//! The `fixture` command and the local `latest.json` writer.
//!
//! `fixtures/tiny` holds a hand-written miniature wiki as SQL dumps plus the
//! snapshot built from it. The snapshot is checked in so the browser tests
//! decode exactly the bytes the Rust builder produces; `fixture --check` (and
//! the Rust test suite) fail if the two drift apart.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};

use crate::build::{build, BuildOptions, BuildSummary, DEFAULT_START_TITLE};
use crate::manifest::{
    self, Latest, SourceFile, SourceLock, LATEST_FILE, MANIFEST_FILE, SCHEMA_VERSION,
    SNAPSHOTS_DIR, TABLES,
};
use crate::util::{sha1_file, sha256_hex, write_file_atomic};

pub const FIXTURE_WIKI: &str = "tinywiki";
pub const FIXTURE_DATE: &str = "20260101";
pub const FIXTURE_SOURCE_FILE: &str = "source.json";

// Deliberately tiny so the ten fixture articles span several shards, several
// title buckets, and several sort runs.
pub const FIXTURE_ADJACENCY_SHARD_SIZE: u32 = 4;
pub const FIXTURE_METADATA_SHARD_SIZE: u32 = 3;
pub const FIXTURE_TITLE_BUCKETS: u32 = 4;
pub const FIXTURE_SORT_CAPACITY: usize = 5;

pub fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures").join("tiny")
}

pub fn fixture_dumps_dir() -> PathBuf {
    fixture_dir().join("dumps")
}

pub fn fixture_public_dir() -> PathBuf {
    fixture_dir().join("public")
}

/// Source lock describing the checked-in fixture dumps as they are on disk.
pub fn fixture_lock(dumps_dir: &Path) -> Result<SourceLock> {
    let mut files = BTreeMap::new();
    for table in TABLES {
        let file = format!("{FIXTURE_WIKI}-{FIXTURE_DATE}-{table}.sql");
        let (bytes, sha1) = sha1_file(&dumps_dir.join(&file))?;
        files.insert(
            table.to_string(),
            SourceFile {
                url: format!("fixture://{FIXTURE_WIKI}/{FIXTURE_DATE}/{file}"),
                file,
                bytes,
                sha1,
                md5: None,
            },
        );
    }
    Ok(SourceLock {
        schema_version: SCHEMA_VERSION,
        wiki: FIXTURE_WIKI.to_string(),
        dump_date: FIXTURE_DATE.to_string(),
        files,
    })
}

pub fn fixture_options(lock: SourceLock, dumps_dir: &Path, work_dir: &Path, public_dir: &Path) -> BuildOptions {
    BuildOptions {
        lock,
        dumps_dir: dumps_dir.to_path_buf(),
        work_dir: work_dir.to_path_buf(),
        snapshot_dir: public_dir.join(SNAPSHOTS_DIR).join(FIXTURE_DATE),
        snapshot_id: FIXTURE_DATE.to_string(),
        start_title: DEFAULT_START_TITLE.to_string(),
        adjacency_shard_size: FIXTURE_ADJACENCY_SHARD_SIZE,
        metadata_shard_size: FIXTURE_METADATA_SHARD_SIZE,
        title_bucket_count: FIXTURE_TITLE_BUCKETS,
        sort_capacity_edges: FIXTURE_SORT_CAPACITY,
        verify_inputs: true,
        force: true,
    }
}

/// Writes `<public_dir>/latest.json` pointing at a local snapshot.
pub fn write_latest(public_dir: &Path, snapshot_id: &str) -> Result<Latest> {
    ensure!(
        manifest::is_snapshot_id(snapshot_id),
        "invalid snapshot ID {snapshot_id:?}"
    );
    let manifest_path = public_dir
        .join(SNAPSHOTS_DIR)
        .join(snapshot_id)
        .join(MANIFEST_FILE);
    let bytes = fs::read(&manifest_path)
        .with_context(|| format!("reading {}", manifest_path.display()))?;
    let parsed: manifest::Manifest = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing {}", manifest_path.display()))?;
    ensure!(
        parsed.snapshot_id == snapshot_id,
        "{} describes snapshot {:?}, not {snapshot_id:?}",
        manifest_path.display(),
        parsed.snapshot_id
    );
    let latest = Latest {
        schema_version: SCHEMA_VERSION,
        snapshot_id: snapshot_id.to_string(),
        manifest_path: manifest::snapshot_manifest_path(snapshot_id),
        manifest_sha256: sha256_hex(&bytes),
    };
    write_file_atomic(&public_dir.join(LATEST_FILE), &manifest::to_pretty_json(&latest)?)?;
    Ok(latest)
}

/// Builds the fixture snapshot and `latest.json` under `public_dir`.
pub fn build_fixture(public_dir: &Path, work_dir: &Path) -> Result<BuildSummary> {
    let dumps_dir = fixture_dumps_dir();
    let lock = fixture_lock(&dumps_dir)?;
    let summary = build(&fixture_options(lock, &dumps_dir, work_dir, public_dir))?;
    write_latest(public_dir, FIXTURE_DATE)?;
    Ok(summary)
}

/// Every file under `root` keyed by its `/`-separated relative path.
pub fn read_tree(root: &Path) -> Result<BTreeMap<String, Vec<u8>>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) -> Result<()> {
        for entry in fs::read_dir(dir).with_context(|| format!("listing {}", dir.display()))? {
            let path = entry?.path();
            if path.is_dir() {
                walk(root, &path, out)?;
            } else {
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                if relative.ends_with(".DS_Store") {
                    continue;
                }
                let bytes =
                    fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
                out.insert(relative, bytes);
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    if root.exists() {
        walk(root, root, &mut out)?;
    }
    Ok(out)
}

/// Describes how two directory trees differ; empty when identical.
pub fn diff_trees(expected: &BTreeMap<String, Vec<u8>>, actual: &BTreeMap<String, Vec<u8>>) -> Vec<String> {
    let mut differences = Vec::new();
    for (path, bytes) in expected {
        match actual.get(path) {
            None => differences.push(format!("missing: {path}")),
            Some(other) if other != bytes => differences.push(format!("differs: {path}")),
            Some(_) => {}
        }
    }
    for path in actual.keys() {
        if !expected.contains_key(path) {
            differences.push(format!("unexpected: {path}"));
        }
    }
    differences
}

/// Regenerates the checked-in fixture, or with `check` verifies it is current.
pub fn run(check: bool) -> Result<()> {
    let dir = fixture_dir();
    let lock = fixture_lock(&fixture_dumps_dir())?;
    let lock_bytes = manifest::to_pretty_json(&lock)?;
    let scratch = tempfile::tempdir().context("creating a scratch directory")?;

    if check {
        let built_public = scratch.path().join("public");
        build_fixture(&built_public, &scratch.path().join("work"))?;
        let mut differences = diff_trees(&read_tree(&built_public)?, &read_tree(&fixture_public_dir())?);
        let checked_in_lock = fs::read(dir.join(FIXTURE_SOURCE_FILE)).unwrap_or_default();
        if checked_in_lock != lock_bytes {
            differences.push(format!("differs: {FIXTURE_SOURCE_FILE}"));
        }
        if !differences.is_empty() {
            bail!(
                "the checked-in fixture is stale; run `wiki-graph fixture` and commit the \
                 result:\n  {}",
                differences.join("\n  ")
            );
        }
        eprintln!("Fixture snapshot is up to date.");
        return Ok(());
    }

    let public = fixture_public_dir();
    if public.exists() {
        fs::remove_dir_all(&public).with_context(|| format!("clearing {}", public.display()))?;
    }
    build_fixture(&public, &scratch.path().join("work"))?;
    write_file_atomic(&dir.join(FIXTURE_SOURCE_FILE), &lock_bytes)?;
    eprintln!("Regenerated the fixture snapshot in {}", public.display());
    Ok(())
}
