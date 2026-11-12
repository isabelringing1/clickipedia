//! Random-access reader over a snapshot directory, performing the same
//! lookups the browser client does. Used by `verify` and by tests.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};

use crate::format::{self, AdjacencyShard, MetadataShard, TitleBucket, TITLE_FLAG_REDIRECT};
use crate::manifest::Manifest;
use crate::titles::{bucket_for, normalize_title};

pub struct SnapshotReader {
    dir: PathBuf,
    manifest: Manifest,
    manifest_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TitleMatch {
    pub ordinal: u32,
    pub is_redirect: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Article {
    pub page_id: u32,
    pub title: String,
}

impl SnapshotReader {
    pub fn open(dir: &Path) -> Result<Self> {
        let (manifest, manifest_bytes) = Manifest::load(dir)?;
        Ok(SnapshotReader {
            dir: dir.to_path_buf(),
            manifest,
            manifest_bytes,
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn manifest_bytes(&self) -> &[u8] {
        &self.manifest_bytes
    }

    pub fn read(&self, relative: &str) -> Result<Vec<u8>> {
        let path = self.dir.join(relative);
        fs::read(&path).with_context(|| format!("reading {}", path.display()))
    }

    fn check_ordinal(&self, ordinal: u32) -> Result<()> {
        ensure!(
            ordinal < self.manifest.counts.articles,
            "ordinal {ordinal} is outside the {} articles",
            self.manifest.counts.articles
        );
        Ok(())
    }

    /// Resolves a title (or redirect alias) to an article ordinal.
    pub fn lookup_title(&self, title: &str) -> Result<Option<TitleMatch>> {
        let Some(normalized) = normalize_title(title) else {
            return Ok(None);
        };
        let titles = &self.manifest.titles;
        let bucket = bucket_for(normalized.as_bytes(), titles.bucket_count);
        let bytes = self.read(&format::shard_path(&titles.dir, bucket))?;
        let decoded = TitleBucket::decode(&bytes)?;
        Ok(decoded
            .lookup(normalized.as_bytes())
            .map(|(ordinal, flags)| TitleMatch {
                ordinal,
                is_redirect: flags & TITLE_FLAG_REDIRECT != 0,
            }))
    }

    /// Out-links of an article, as ascending ordinals.
    pub fn neighbors(&self, ordinal: u32) -> Result<Vec<u32>> {
        self.check_ordinal(ordinal)?;
        let adjacency = &self.manifest.adjacency;
        let shard = ordinal / adjacency.shard_size;
        let bytes = self.read(&format::shard_path(&adjacency.dir, shard))?;
        let decoded = AdjacencyShard::decode(&bytes)?;
        ensure!(
            decoded.first_ordinal == shard * adjacency.shard_size,
            "adjacency shard {shard} starts at the wrong ordinal"
        );
        let local = (ordinal - decoded.first_ordinal) as usize;
        ensure!(
            local < decoded.count() as usize,
            "adjacency shard {shard} does not contain ordinal {ordinal}"
        );
        Ok(decoded.neighbors(local).to_vec())
    }

    pub fn article(&self, ordinal: u32) -> Result<Article> {
        self.check_ordinal(ordinal)?;
        let metadata = &self.manifest.metadata;
        let shard = ordinal / metadata.shard_size;
        let bytes = self.read(&format::shard_path(&metadata.dir, shard))?;
        let decoded = MetadataShard::decode(&bytes)?;
        ensure!(
            decoded.first_ordinal == shard * metadata.shard_size,
            "metadata shard {shard} starts at the wrong ordinal"
        );
        let local = (ordinal - decoded.first_ordinal) as usize;
        ensure!(
            local < decoded.count() as usize,
            "metadata shard {shard} does not contain ordinal {ordinal}"
        );
        Ok(Article {
            page_id: decoded.page_ids[local],
            title: String::from_utf8_lossy(decoded.title(local)).into_owned(),
        })
    }
}
