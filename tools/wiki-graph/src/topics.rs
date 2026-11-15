//! Deterministic adapter for pinned article-topic scores.
//!
//! Production classification exports are normalized before graph building to
//! UTF-8 JSONL in strictly ascending page-ID order:
//!
//! `{"pageId":123,"scores":[["computing",812345],["software",700000]]}`
//!
//! Scores are integer millionths. This avoids depending on an unstable
//! CirrusSearch document shape and makes threshold behavior reproducible.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};

use crate::util::sha256_hex;

pub const FORMAT_NAME: &str = "clickipedia-topic-scores-jsonl-v1";
pub const SCORE_UNIT: &str = "millionths";
pub const CATALOG_BYTES: &[u8] = include_bytes!("../../../topic-catalog.json");

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TopicCatalogFile {
    pub schema_version: u32,
    pub topics: Vec<TopicDefinition>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct TopicDefinition {
    pub id: String,
    pub label: String,
}

pub fn catalog() -> Result<TopicCatalogFile> {
    let parsed: TopicCatalogFile =
        serde_json::from_slice(CATALOG_BYTES).context("parsing topic-catalog.json")?;
    ensure!(
        parsed.schema_version == 1,
        "unsupported topic catalog schema"
    );
    ensure!(
        parsed.topics.len() == 64,
        "topic catalog must contain exactly 64 topics"
    );
    let ids: BTreeSet<_> = parsed.topics.iter().map(|topic| &topic.id).collect();
    ensure!(ids.len() == 64, "topic catalog IDs are not unique");
    ensure!(
        parsed
            .topics
            .iter()
            .all(|topic| !topic.id.is_empty() && !topic.label.is_empty()),
        "topic catalog contains an empty ID or label"
    );
    Ok(parsed)
}

pub fn catalog_sha256() -> String {
    sha256_hex(CATALOG_BYTES)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TopicRow {
    page_id: u32,
    scores: Vec<(String, u32)>,
}

pub struct TopicReader {
    lines: std::io::Lines<BufReader<File>>,
    bits: BTreeMap<String, u32>,
    threshold: u32,
    next: Option<(u32, u64)>,
    previous_page_id: Option<u32>,
    line_number: u64,
}

impl TopicReader {
    pub fn open(path: &Path, threshold: u32, catalog: &TopicCatalogFile) -> Result<Self> {
        ensure!(
            threshold <= 1_000_000,
            "topic threshold exceeds one million"
        );
        let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
        let bits = catalog
            .topics
            .iter()
            .enumerate()
            .map(|(bit, topic)| (topic.id.clone(), bit as u32))
            .collect();
        let mut reader = TopicReader {
            lines: BufReader::new(file).lines(),
            bits,
            threshold,
            next: None,
            previous_page_id: None,
            line_number: 0,
        };
        reader.advance()?;
        Ok(reader)
    }

    fn advance(&mut self) -> Result<()> {
        self.next = None;
        for line in self.lines.by_ref() {
            self.line_number += 1;
            let line = line.with_context(|| format!("reading topic line {}", self.line_number))?;
            ensure!(
                !line.trim().is_empty(),
                "topic line {} is empty",
                self.line_number
            );
            let row: TopicRow = serde_json::from_str(&line)
                .with_context(|| format!("parsing topic line {}", self.line_number))?;
            if let Some(previous) = self.previous_page_id {
                ensure!(
                    row.page_id > previous,
                    "topic page IDs are not strictly ascending at line {}",
                    self.line_number
                );
            }
            self.previous_page_id = Some(row.page_id);
            let mut mask = 0u64;
            let mut seen = BTreeSet::new();
            for (id, score) in row.scores {
                ensure!(
                    score <= 1_000_000,
                    "topic score for {id:?} exceeds one million at line {}",
                    self.line_number
                );
                ensure!(
                    seen.insert(id.clone()),
                    "duplicate topic {id:?} at line {}",
                    self.line_number
                );
                let bit = self.bits.get(&id).with_context(|| {
                    format!("unknown topic {id:?} at line {}", self.line_number)
                })?;
                if score >= self.threshold {
                    mask |= 1u64 << bit;
                }
            }
            self.next = Some((row.page_id, mask));
            return Ok(());
        }
        Ok(())
    }

    /// Returns the mask for an article page ID. Source rows not present in
    /// the graph are streamed past; graph articles without a row get mask 0.
    pub fn mask_for(&mut self, page_id: u32) -> Result<u64> {
        while self.next.is_some_and(|(source_id, _)| source_id < page_id) {
            self.advance()?;
        }
        if self.next.is_some_and(|(source_id, _)| source_id == page_id) {
            let mask = self.next.unwrap().1;
            self.advance()?;
            Ok(mask)
        } else {
            Ok(0)
        }
    }

    pub fn finish(mut self) -> Result<()> {
        while self.next.is_some() {
            self.advance()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn catalog_is_exactly_one_u64() {
        let catalog = catalog().unwrap();
        assert_eq!(catalog.topics.len(), 64);
        assert_eq!(catalog.topics[0].label, "Biography*");
        assert_eq!(catalog.topics[63].label, "Technology");
    }

    #[test]
    fn reader_merge_joins_and_keeps_multiple_labels() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, r#"{{"pageId":2,"scores":[["women",500000]]}}"#).unwrap();
        writeln!(
            file,
            r#"{{"pageId":7,"scores":[["biography",900000],["technology",800000]]}}"#
        )
        .unwrap();
        let catalog = catalog().unwrap();
        let mut reader = TopicReader::open(file.path(), 600_000, &catalog).unwrap();
        assert_eq!(reader.mask_for(1).unwrap(), 0);
        assert_eq!(reader.mask_for(2).unwrap(), 0);
        assert_eq!(reader.mask_for(7).unwrap(), 1 | (1u64 << 63));
        reader.finish().unwrap();
    }
}
