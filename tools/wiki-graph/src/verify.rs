//! The `verify` and `compare` commands.
//!
//! `verify` checks a snapshot directory against its own manifest: every file's
//! length and SHA-256, every shard's structure, cross-consistency between the
//! title index and article metadata, and (unless `--quick`) a full recompute
//! of the connectivity report.
//!
//! `compare` guards a refresh: it fails when a newer snapshot's totals move
//! implausibly far from the snapshot it would replace.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};

use crate::connectivity::{self, ConnectivityReport, CsrBuilder};
use crate::format::{
    self, AdjacencyShard, MetadataShard, ShardIndex, TitleBucket, TITLE_FLAG_REDIRECT,
};
use crate::manifest::{self, FileRef, Manifest};
use crate::snapshot::SnapshotReader;
use crate::titles::{bucket_for, MAX_TITLE_BYTES, TITLE_HASH_NAME};
use crate::util::{hex, human_bytes, human_count, sha256, sha256_hex, Progress};

pub struct VerifyOptions {
    pub snapshot_dir: PathBuf,
    /// Skip the checks that need the whole graph or every title in memory.
    pub quick: bool,
    /// `(from, to)` title pairs that must be linked.
    pub expect_links: Vec<(String, String)>,
    /// Another build of the same snapshot that must be byte-identical.
    pub same_as: Option<PathBuf>,
}

#[derive(Debug)]
pub struct VerifyOutcome {
    pub manifest: Manifest,
    pub manifest_sha256: String,
    pub files: u64,
    pub bytes: u64,
}

struct Checker<'a> {
    reader: &'a SnapshotReader,
    files: u64,
    bytes: u64,
}

impl Checker<'_> {
    fn read_exact(&mut self, relative: &str, bytes: u64, sha256_hex_expected: &str) -> Result<Vec<u8>> {
        let data = self.reader.read(relative)?;
        ensure!(
            data.len() as u64 == bytes,
            "{relative}: expected {bytes} bytes, found {}",
            data.len()
        );
        let actual = sha256_hex(&data);
        ensure!(
            actual == sha256_hex_expected,
            "{relative}: SHA-256 is {actual}, expected {sha256_hex_expected}"
        );
        self.files += 1;
        self.bytes += data.len() as u64;
        Ok(data)
    }

    fn read_ref(&mut self, reference: &FileRef) -> Result<Vec<u8>> {
        self.read_exact(&reference.path, reference.bytes, &reference.sha256)
    }

    fn read_index(&mut self, dir: &str, reference: &FileRef, kind: u32, count: u32) -> Result<ShardIndex> {
        ensure!(
            reference.path == format::index_path(dir),
            "index for {dir} has unexpected path {}",
            reference.path
        );
        let index = ShardIndex::decode(&self.read_ref(reference)?)
            .with_context(|| format!("decoding {}", reference.path))?;
        ensure!(index.kind == kind, "{}: wrong index kind", reference.path);
        ensure!(
            index.entries.len() == count as usize,
            "{}: lists {} shards but the manifest says {count}",
            reference.path,
            index.entries.len()
        );
        Ok(index)
    }

    fn read_shard(&mut self, dir: &str, index: &ShardIndex, shard: u32) -> Result<Vec<u8>> {
        let entry = &index.entries[shard as usize];
        self.read_exact(
            &format::shard_path(dir, shard),
            entry.bytes as u64,
            &hex(&entry.sha256),
        )
    }
}

fn expected_shard_count(articles: u32, shard_size: u32) -> u32 {
    articles.div_ceil(shard_size)
}

pub fn verify(options: &VerifyOptions) -> Result<VerifyOutcome> {
    let reader = SnapshotReader::open(&options.snapshot_dir)?;
    let manifest = reader.manifest().clone();
    let manifest_sha256 = sha256_hex(reader.manifest_bytes());
    let articles = manifest.counts.articles;
    eprintln!(
        "Verifying snapshot {} in {}",
        manifest.snapshot_id,
        options.snapshot_dir.display()
    );

    ensure!(
        manifest::is_snapshot_id(&manifest.snapshot_id),
        "manifest has an invalid snapshot ID"
    );
    ensure!(articles > 0, "manifest lists no articles");
    ensure!(
        manifest.titles.hash == TITLE_HASH_NAME,
        "unknown title hash {:?}",
        manifest.titles.hash
    );
    ensure!(
        manifest.adjacency.shard_size > 0
            && manifest.metadata.shard_size > 0
            && manifest.titles.bucket_count > 0,
        "manifest has a zero shard size or bucket count"
    );
    ensure!(
        manifest.adjacency.shard_count
            == expected_shard_count(articles, manifest.adjacency.shard_size),
        "adjacency shard count does not match the article count"
    );
    ensure!(
        manifest.metadata.shard_count
            == expected_shard_count(articles, manifest.metadata.shard_size),
        "metadata shard count does not match the article count"
    );
    ensure!(
        manifest.counts.title_entries == articles + manifest.counts.redirect_aliases,
        "title entry count is not articles plus redirect aliases"
    );
    ensure!(
        manifest.start_article.ordinal < articles,
        "start article ordinal is out of range"
    );

    let mut checker = Checker {
        reader: &reader,
        files: 1,
        bytes: reader.manifest_bytes().len() as u64,
    };

    // ---- metadata ----
    let metadata_index = checker.read_index(
        &manifest.metadata.dir,
        &manifest.metadata.index,
        format::KIND_METADATA,
        manifest.metadata.shard_count,
    )?;
    let mut progress = Progress::new("metadata");
    let mut previous_page_id: Option<u32> = None;
    // Titles of every article, kept only for the full cross-check.
    let mut title_arena: Vec<u8> = Vec::new();
    let mut title_offsets: Vec<u64> = vec![0];
    let mut start_title: Option<Vec<u8>> = None;
    for shard in 0..manifest.metadata.shard_count {
        let bytes = checker.read_shard(&manifest.metadata.dir, &metadata_index, shard)?;
        let decoded = MetadataShard::decode(&bytes)
            .with_context(|| format!("decoding metadata shard {shard}"))?;
        let first = shard * manifest.metadata.shard_size;
        let count = manifest.metadata.shard_size.min(articles - first);
        ensure!(
            decoded.first_ordinal == first && decoded.count() == count,
            "metadata shard {shard} covers the wrong ordinal range"
        );
        for local in 0..count as usize {
            let page_id = decoded.page_ids[local];
            if let Some(previous) = previous_page_id {
                ensure!(
                    page_id > previous,
                    "metadata shard {shard}: page IDs are not strictly ascending"
                );
            }
            previous_page_id = Some(page_id);
            let title = decoded.title(local);
            ensure!(
                !title.is_empty() && title.len() <= MAX_TITLE_BYTES,
                "metadata shard {shard}: title {local} has an invalid length"
            );
            if first + local as u32 == manifest.start_article.ordinal {
                start_title = Some(title.to_vec());
            }
            if !options.quick {
                title_arena.extend_from_slice(title);
                title_offsets.push(title_arena.len() as u64);
            }
        }
        progress.tick(|| format!("{} / {} shards", shard + 1, manifest.metadata.shard_count));
    }
    progress.done(format!("{} shards", manifest.metadata.shard_count));
    ensure!(
        start_title.as_deref() == Some(manifest.start_article.title.as_bytes()),
        "start article ordinal {} is not titled {:?}",
        manifest.start_article.ordinal,
        manifest.start_article.title
    );

    // ---- titles ----
    let titles_index = checker.read_index(
        &manifest.titles.dir,
        &manifest.titles.index,
        format::KIND_TITLES,
        manifest.titles.bucket_count,
    )?;
    let mut progress = Progress::new("titles");
    let mut canonical_entries = 0u64;
    let mut alias_entries = 0u64;
    let mut seen_canonical = if options.quick {
        Vec::new()
    } else {
        vec![false; articles as usize]
    };
    for bucket in 0..manifest.titles.bucket_count {
        let bytes = checker.read_shard(&manifest.titles.dir, &titles_index, bucket)?;
        let decoded =
            TitleBucket::decode(&bytes).with_context(|| format!("decoding title bucket {bucket}"))?;
        ensure!(
            decoded.bucket == bucket,
            "title bucket {bucket} is labelled {}",
            decoded.bucket
        );
        for entry in 0..decoded.count() as usize {
            let title = decoded.title(entry);
            let ordinal = decoded.ordinals[entry];
            let flags = decoded.flags[entry];
            ensure!(
                ordinal < articles,
                "title bucket {bucket}: ordinal {ordinal} is out of range"
            );
            ensure!(
                flags & !TITLE_FLAG_REDIRECT == 0,
                "title bucket {bucket}: unknown flag bits {flags:#x}"
            );
            ensure!(
                bucket_for(title, manifest.titles.bucket_count) == bucket,
                "title bucket {bucket}: {:?} hashes to another bucket",
                String::from_utf8_lossy(title)
            );
            if flags & TITLE_FLAG_REDIRECT != 0 {
                alias_entries += 1;
                continue;
            }
            canonical_entries += 1;
            if !options.quick {
                let start = title_offsets[ordinal as usize] as usize;
                let end = title_offsets[ordinal as usize + 1] as usize;
                ensure!(
                    &title_arena[start..end] == title,
                    "title index maps {:?} to ordinal {ordinal}, whose metadata title differs",
                    String::from_utf8_lossy(title)
                );
                ensure!(
                    !seen_canonical[ordinal as usize],
                    "ordinal {ordinal} has two canonical title entries"
                );
                seen_canonical[ordinal as usize] = true;
            }
        }
        progress.tick(|| format!("{} / {} buckets", bucket + 1, manifest.titles.bucket_count));
    }
    progress.done(format!("{} buckets", manifest.titles.bucket_count));
    ensure!(
        canonical_entries == articles as u64,
        "title index has {canonical_entries} canonical entries for {articles} articles"
    );
    ensure!(
        alias_entries == manifest.counts.redirect_aliases as u64,
        "title index has {alias_entries} aliases but the manifest says {}",
        manifest.counts.redirect_aliases
    );
    drop(seen_canonical);

    // ---- adjacency ----
    let adjacency_index = checker.read_index(
        &manifest.adjacency.dir,
        &manifest.adjacency.index,
        format::KIND_ADJACENCY,
        manifest.adjacency.shard_count,
    )?;
    let mut progress = Progress::new("adjacency");
    let mut edges = 0u64;
    let mut graph = (!options.quick).then(|| CsrBuilder::new(articles));
    for shard in 0..manifest.adjacency.shard_count {
        let bytes = checker.read_shard(&manifest.adjacency.dir, &adjacency_index, shard)?;
        let decoded = AdjacencyShard::decode(&bytes)
            .with_context(|| format!("decoding adjacency shard {shard}"))?;
        let first = shard * manifest.adjacency.shard_size;
        let count = manifest.adjacency.shard_size.min(articles - first);
        ensure!(
            decoded.first_ordinal == first && decoded.count() == count,
            "adjacency shard {shard} covers the wrong ordinal range"
        );
        for local in 0..count as usize {
            let source = first + local as u32;
            let mut previous: Option<u32> = None;
            for &target in decoded.neighbors(local) {
                ensure!(
                    target < articles,
                    "adjacency shard {shard}: target {target} of {source} does not exist"
                );
                ensure!(
                    target != source,
                    "adjacency shard {shard}: {source} links to itself"
                );
                if let Some(previous) = previous {
                    ensure!(
                        target > previous,
                        "adjacency shard {shard}: targets of {source} are not strictly ascending"
                    );
                }
                previous = Some(target);
                if let Some(graph) = graph.as_mut() {
                    graph.push(source, target);
                }
            }
        }
        edges += decoded.targets.len() as u64;
        progress.tick(|| {
            format!(
                "{} / {} shards, {} edges",
                shard + 1,
                manifest.adjacency.shard_count,
                human_count(edges)
            )
        });
    }
    progress.done(format!(
        "{} shards, {} edges",
        manifest.adjacency.shard_count,
        human_count(edges)
    ));
    ensure!(
        edges == manifest.counts.edges,
        "adjacency shards hold {edges} edges but the manifest says {}",
        manifest.counts.edges
    );

    // ---- reports ----
    let mut report_bytes = Vec::new();
    for name in [
        connectivity::REPORT_CONNECTIVITY,
        connectivity::REPORT_ZERO_INDEGREE,
        connectivity::REPORT_ISOLATED,
        connectivity::REPORT_UNREACHABLE,
    ] {
        let reference = manifest
            .reports
            .get(name)
            .with_context(|| format!("manifest has no `{name}` report"))?;
        report_bytes.push(checker.read_ref(reference)?);
    }
    let report: ConnectivityReport =
        serde_json::from_slice(&report_bytes[0]).context("parsing the connectivity report")?;
    ensure!(
        report.snapshot_id == manifest.snapshot_id
            && report.articles == articles
            && report.edges == manifest.counts.edges
            && report.start.ordinal == manifest.start_article.ordinal,
        "connectivity report describes a different snapshot"
    );
    ensure!(
        report.start.reachable as u64 + report.start.unreachable as u64 == articles as u64,
        "connectivity report: reachable plus unreachable is not the article count"
    );
    for (list, bytes, label) in [
        (&report.zero_indegree, &report_bytes[1], "zero-indegree"),
        (&report.isolated, &report_bytes[2], "isolated"),
        (&report.unreachable_from_start, &report_bytes[3], "unreachable"),
    ] {
        ensure!(
            bytes.len() as u64 == list.count as u64 * 4,
            "{label} list length does not match its count"
        );
    }
    ensure!(
        report.start.unreachable == report.unreachable_from_start.count,
        "connectivity report: inconsistent unreachable counts"
    );

    if let Some(graph) = graph {
        eprintln!("Recomputing connectivity");
        let graph = graph.finish();
        let analysis = connectivity::analyze(&graph, manifest.start_article.ordinal);
        let title_of = |ordinal: u32| {
            let start = title_offsets[ordinal as usize] as usize;
            let end = title_offsets[ordinal as usize + 1] as usize;
            String::from_utf8_lossy(&title_arena[start..end]).into_owned()
        };
        let recomputed = connectivity::build_report(
            &manifest.snapshot_id,
            &graph,
            manifest.start_article.ordinal,
            &analysis,
            &title_of,
        );
        ensure!(
            manifest::to_pretty_json(&recomputed)? == report_bytes[0],
            "connectivity report does not match a recomputation from the shards"
        );
        for (ordinals, bytes, label) in [
            (&analysis.zero_indegree, &report_bytes[1], "zero-indegree"),
            (&analysis.isolated, &report_bytes[2], "isolated"),
            (&analysis.unreachable_from_start, &report_bytes[3], "unreachable"),
        ] {
            ensure!(
                &connectivity::encode_ordinal_list(ordinals) == bytes,
                "{label} list does not match a recomputation from the shards"
            );
        }
    }

    // ---- lookups, exactly as the browser performs them ----
    let start = reader
        .lookup_title(&manifest.start_article.title)?
        .with_context(|| {
            format!(
                "start article {:?} is missing from the title index",
                manifest.start_article.title
            )
        })?;
    ensure!(
        start.ordinal == manifest.start_article.ordinal && !start.is_redirect,
        "title index resolves the start article to the wrong ordinal"
    );
    for (from, to) in &options.expect_links {
        let source = reader
            .lookup_title(from)?
            .with_context(|| format!("expected link source {from:?} is not in the snapshot"))?;
        let target = reader
            .lookup_title(to)?
            .with_context(|| format!("expected link target {to:?} is not in the snapshot"))?;
        ensure!(
            reader
                .neighbors(source.ordinal)?
                .binary_search(&target.ordinal)
                .is_ok(),
            "expected a link from {from:?} to {to:?}, but there is none"
        );
        eprintln!("  link present: {from} -> {to}");
    }

    if let Some(other) = &options.same_as {
        let path = other.join(manifest::MANIFEST_FILE);
        let other_bytes = fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
        ensure!(
            sha256(&other_bytes) == sha256(reader.manifest_bytes()),
            "{} differs from this snapshot's manifest: the builds are not identical",
            path.display()
        );
        eprintln!("  identical to {}", other.display());
    }

    eprintln!(
        "OK: {} files, {}; {} articles, {} edges, {} title entries{}",
        human_count(checker.files),
        human_bytes(checker.bytes),
        human_count(articles as u64),
        human_count(edges),
        human_count(manifest.counts.title_entries as u64),
        if options.quick {
            " (quick: connectivity and title cross-checks skipped)"
        } else {
            ""
        }
    );
    Ok(VerifyOutcome {
        manifest,
        manifest_sha256,
        files: checker.files,
        bytes: checker.bytes,
    })
}

// ---- compare ---------------------------------------------------------------

/// Bounds on how far a refreshed snapshot may move from its predecessor.
#[derive(Debug, Clone)]
pub struct Thresholds {
    /// Allowed fractional change in articles: `(max decrease, max increase)`.
    pub articles: (f64, f64),
    pub edges: (f64, f64),
    pub redirect_aliases: (f64, f64),
    /// Largest allowed drop, in fractions of all articles, of the share
    /// reachable from the start article and of the largest component.
    pub reachable_share_drop: f64,
    pub largest_component_share_drop: f64,
    /// Largest allowed fractional growth of the zero-indegree count.
    pub zero_indegree_growth: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Thresholds {
            articles: (0.005, 0.05),
            edges: (0.02, 0.10),
            redirect_aliases: (0.02, 0.10),
            reachable_share_drop: 0.005,
            largest_component_share_drop: 0.01,
            zero_indegree_growth: 0.25,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub metric: &'static str,
    pub old: f64,
    pub new: f64,
    pub regression: Option<String>,
}

fn load_report(dir: &Path, manifest: &Manifest) -> Result<ConnectivityReport> {
    let reference = manifest
        .reports
        .get(connectivity::REPORT_CONNECTIVITY)
        .context("manifest has no connectivity report")?;
    let path = dir.join(&reference.path);
    let bytes = fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))
}

fn relative_change(old: f64, new: f64) -> f64 {
    if old == 0.0 {
        if new == 0.0 {
            0.0
        } else {
            f64::INFINITY
        }
    } else {
        (new - old) / old
    }
}

fn check_count(
    metric: &'static str,
    old: u64,
    new: u64,
    (max_drop, max_growth): (f64, f64),
) -> Finding {
    let change = relative_change(old as f64, new as f64);
    let regression = if change < -max_drop {
        Some(format!(
            "fell {:.2}% (limit {:.2}%)",
            -change * 100.0,
            max_drop * 100.0
        ))
    } else if change > max_growth {
        Some(format!(
            "grew {:.2}% (limit {:.2}%)",
            change * 100.0,
            max_growth * 100.0
        ))
    } else {
        None
    };
    Finding {
        metric,
        old: old as f64,
        new: new as f64,
        regression,
    }
}

fn check_share(metric: &'static str, old: f64, new: f64, max_drop: f64) -> Finding {
    let regression = (old - new > max_drop).then(|| {
        format!(
            "fell {:.3} percentage points (limit {:.3})",
            (old - new) * 100.0,
            max_drop * 100.0
        )
    });
    Finding {
        metric,
        old,
        new,
        regression,
    }
}

/// Pure comparison of two snapshots' totals.
pub fn compare_snapshots(
    old: (&Manifest, &ConnectivityReport),
    new: (&Manifest, &ConnectivityReport),
    thresholds: &Thresholds,
) -> Vec<Finding> {
    let (old_manifest, old_report) = old;
    let (new_manifest, new_report) = new;
    let share = |part: u32, manifest: &Manifest| part as f64 / manifest.counts.articles as f64;

    let mut findings = vec![
        check_count(
            "articles",
            old_manifest.counts.articles as u64,
            new_manifest.counts.articles as u64,
            thresholds.articles,
        ),
        check_count(
            "edges",
            old_manifest.counts.edges,
            new_manifest.counts.edges,
            thresholds.edges,
        ),
        check_count(
            "redirect aliases",
            old_manifest.counts.redirect_aliases as u64,
            new_manifest.counts.redirect_aliases as u64,
            thresholds.redirect_aliases,
        ),
        check_count(
            "zero-indegree articles",
            old_report.zero_indegree.count as u64,
            new_report.zero_indegree.count as u64,
            (f64::INFINITY, thresholds.zero_indegree_growth),
        ),
        check_share(
            "share reachable from start",
            share(old_report.start.reachable, old_manifest),
            share(new_report.start.reachable, new_manifest),
            thresholds.reachable_share_drop,
        ),
        check_share(
            "share in largest component",
            share(old_report.strongly_connected_components.largest, old_manifest),
            share(new_report.strongly_connected_components.largest, new_manifest),
            thresholds.largest_component_share_drop,
        ),
    ];

    let mut order = Finding {
        metric: "dump date",
        old: old_manifest.dump_date.parse().unwrap_or(0.0),
        new: new_manifest.dump_date.parse().unwrap_or(0.0),
        regression: None,
    };
    if new_manifest.dump_date <= old_manifest.dump_date {
        order.regression = Some(format!(
            "{} is not newer than {}",
            new_manifest.dump_date, old_manifest.dump_date
        ));
    }
    findings.push(order);

    if new_manifest.start_article.title != old_manifest.start_article.title {
        findings.push(Finding {
            metric: "start article",
            old: old_manifest.start_article.ordinal as f64,
            new: new_manifest.start_article.ordinal as f64,
            regression: Some(format!(
                "changed from {:?} to {:?}",
                old_manifest.start_article.title, new_manifest.start_article.title
            )),
        });
    }
    findings
}

/// Compares two snapshot directories; errors on a regression unless allowed.
pub fn compare(old_dir: &Path, new_dir: &Path, allow_regression: bool) -> Result<Vec<Finding>> {
    let (old_manifest, _) = Manifest::load(old_dir)?;
    let (new_manifest, _) = Manifest::load(new_dir)?;
    let old_report = load_report(old_dir, &old_manifest)?;
    let new_report = load_report(new_dir, &new_manifest)?;
    let findings = compare_snapshots(
        (&old_manifest, &old_report),
        (&new_manifest, &new_report),
        &Thresholds::default(),
    );

    eprintln!(
        "Comparing {} (old) with {} (new)",
        old_manifest.snapshot_id, new_manifest.snapshot_id
    );
    for finding in &findings {
        let (old, new) = if finding.metric.starts_with("share") {
            (
                format!("{:.4}%", finding.old * 100.0),
                format!("{:.4}%", finding.new * 100.0),
            )
        } else {
            (
                human_count(finding.old as u64),
                human_count(finding.new as u64),
            )
        };
        match &finding.regression {
            Some(reason) => eprintln!("  FAIL {:<28} {old} -> {new}: {reason}", finding.metric),
            None => eprintln!("  ok   {:<28} {old} -> {new}", finding.metric),
        }
    }

    let regressions = findings.iter().filter(|f| f.regression.is_some()).count();
    if regressions > 0 {
        if allow_regression {
            eprintln!("{regressions} implausible change(s) accepted by --allow-regression");
        } else {
            bail!(
                "{regressions} implausible change(s) between snapshots; inspect the build, or \
                 pass --allow-regression if the change is real"
            );
        }
    }
    Ok(findings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_thresholds_are_two_sided() {
        assert!(check_count("x", 1000, 1000, (0.01, 0.05)).regression.is_none());
        assert!(check_count("x", 1000, 995, (0.01, 0.05)).regression.is_none());
        assert!(check_count("x", 1000, 980, (0.01, 0.05)).regression.is_some());
        assert!(check_count("x", 1000, 1040, (0.01, 0.05)).regression.is_none());
        assert!(check_count("x", 1000, 1100, (0.01, 0.05)).regression.is_some());
        assert!(check_count("x", 0, 0, (0.01, 0.05)).regression.is_none());
        assert!(check_count("x", 0, 5, (0.01, 0.05)).regression.is_some());
        // An unbounded decrease is allowed when the limit is infinite.
        assert!(check_count("x", 1000, 1, (f64::INFINITY, 0.25)).regression.is_none());
    }

    #[test]
    fn share_threshold_only_flags_drops() {
        assert!(check_share("s", 0.95, 0.96, 0.005).regression.is_none());
        assert!(check_share("s", 0.95, 0.947, 0.005).regression.is_none());
        assert!(check_share("s", 0.95, 0.94, 0.005).regression.is_some());
    }
}
