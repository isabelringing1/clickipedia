//! The `build` command: turns the four SQL dumps into an immutable snapshot
//! directory of adjacency shards, metadata shards, title buckets, reports, and
//! a manifest.
//!
//! Memory is bounded by the page table (titles for every namespace-0 page),
//! the external sort buffer, and finally the in-memory graph used for the
//! connectivity report. Nothing is ever loaded into a SQL database.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};

use crate::connectivity::{self, CsrBuilder};
use crate::extsort::EdgeSorter;
use crate::format::{
    self, AdjacencyShard, IndexEntry, MetadataShard, ShardIndex, TitleBucket, TITLE_FLAG_REDIRECT,
};
use crate::manifest::{
    self, Counts, FileRef, Generator, Manifest, ManifestSource, RangeShards, SourceLock,
    StartArticle, TitleBuckets, MANIFEST_FILE, SCHEMA_VERSION, TABLES,
};
use crate::pages::{PageTable, RedirectStats, MAIN_NAMESPACE, NONE};
use crate::sql::{open_dump, Row};
use crate::titles::{bucket_for, normalize_title, TITLE_HASH_NAME};
use crate::util::{
    human_bytes, human_count, sha1_file, sha256, sha256_hex, write_file_atomic, Progress,
};

pub const DEFAULT_START_TITLE: &str = "Incremental_game";
// The defaults trade browser fetch size against object count. R2 uploads go
// through an API limited to roughly 1,200 requests per five minutes, so each
// extra thousand objects adds about five minutes to every publication. For
// English Wikipedia these give about 9,000 objects: adjacency shards of a few
// hundred kilobytes, and metadata shards and title buckets near 100 KiB.
pub const DEFAULT_ADJACENCY_SHARD_SIZE: u32 = 2048;
pub const DEFAULT_METADATA_SHARD_SIZE: u32 = 4096;
pub const DEFAULT_TITLE_BUCKETS: u32 = 4096;
pub const DEFAULT_SORT_MEMORY_MB: usize = 1024;

pub struct BuildOptions {
    pub lock: SourceLock,
    /// Directory holding the dump files named in the lock.
    pub dumps_dir: PathBuf,
    /// Scratch directory for sort runs; emptied before and after the build.
    pub work_dir: PathBuf,
    /// Final snapshot directory, e.g. `public/snapshots/20261001`.
    pub snapshot_dir: PathBuf,
    pub snapshot_id: String,
    pub start_title: String,
    pub adjacency_shard_size: u32,
    pub metadata_shard_size: u32,
    pub title_bucket_count: u32,
    /// Edges held in memory by the external sorter (8 bytes each).
    pub sort_capacity_edges: usize,
    /// Re-hash the dump files against the lock before building.
    pub verify_inputs: bool,
    /// Replace an existing snapshot directory.
    pub force: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LinkStats {
    pub rows: u64,
    pub source_other_namespace: u64,
    /// Target is a red link, another namespace, or an unresolved redirect.
    pub target_unresolved: u64,
    /// Source page is a redirect or does not exist.
    pub source_not_article: u64,
    pub self_links: u64,
    /// Edges handed to the sorter, before deduplication.
    pub emitted: u64,
    pub unique: u64,
}

pub struct BuildSummary {
    pub manifest: Manifest,
    pub manifest_sha256: String,
    pub redirects: RedirectStats,
    pub links: LinkStats,
    pub total_bytes: u64,
    pub file_count: u64,
}

/// Writes the shards of one kind and accumulates their index.
struct ShardSink {
    root: PathBuf,
    dir: &'static str,
    kind: u32,
    entries: Vec<IndexEntry>,
    total_bytes: u64,
}

impl ShardSink {
    fn new(root: &Path, dir: &'static str, kind: u32) -> Result<Self> {
        let path = root.join(dir);
        fs::create_dir_all(&path).with_context(|| format!("creating {}", path.display()))?;
        Ok(ShardSink {
            root: root.to_path_buf(),
            dir,
            kind,
            entries: Vec::new(),
            total_bytes: 0,
        })
    }

    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        let index = u32::try_from(self.entries.len()).context("too many shards")?;
        let path = self.root.join(format::shard_path(self.dir, index));
        fs::write(&path, bytes).with_context(|| format!("writing {}", path.display()))?;
        self.entries.push(IndexEntry {
            bytes: u32::try_from(bytes.len()).context("shard exceeds 4 GiB")?,
            sha256: sha256(bytes),
        });
        self.total_bytes += bytes.len() as u64;
        Ok(())
    }

    /// Writes the index file; returns its reference, the shard count, and the
    /// total bytes written including the index.
    fn finish(self) -> Result<(FileRef, u32, u64)> {
        let count = self.entries.len() as u32;
        let index = ShardIndex {
            kind: self.kind,
            entries: self.entries,
        };
        let bytes = index.encode();
        let relative = format::index_path(self.dir);
        let path = self.root.join(&relative);
        fs::write(&path, &bytes).with_context(|| format!("writing {}", path.display()))?;
        let reference = FileRef {
            path: relative,
            bytes: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
        };
        Ok((reference, count, self.total_bytes + bytes.len() as u64))
    }
}

/// Cuts a sorted edge stream into fixed source-range shards.
struct AdjacencyWriter {
    sink: ShardSink,
    shard_size: u32,
    article_count: u32,
    first: u32,
    offsets: Vec<u32>,
    targets: Vec<u32>,
}

impl AdjacencyWriter {
    fn new(sink: ShardSink, shard_size: u32, article_count: u32) -> Self {
        AdjacencyWriter {
            sink,
            shard_size,
            article_count,
            first: 0,
            offsets: vec![0],
            targets: Vec::new(),
        }
    }

    fn current_count(&self) -> u32 {
        self.shard_size.min(self.article_count - self.first)
    }

    fn push(&mut self, source: u32, target: u32) -> Result<()> {
        ensure!(
            source < self.article_count && target < self.article_count,
            "edge ({source}, {target}) is outside the {} articles",
            self.article_count
        );
        ensure!(source >= self.first, "edges are not sorted by source");
        while source - self.first >= self.current_count() {
            self.flush()?;
        }
        let local = (source - self.first) as usize;
        while self.offsets.len() <= local {
            self.offsets.push(self.targets.len() as u32);
        }
        self.targets.push(target);
        ensure!(
            self.targets.len() < u32::MAX as usize / 4,
            "adjacency shard starting at ordinal {} is too large; use a smaller shard size",
            self.first
        );
        Ok(())
    }

    fn flush(&mut self) -> Result<()> {
        let count = self.current_count() as usize;
        while self.offsets.len() <= count {
            self.offsets.push(self.targets.len() as u32);
        }
        let shard = AdjacencyShard {
            first_ordinal: self.first,
            offsets: std::mem::take(&mut self.offsets),
            targets: std::mem::take(&mut self.targets),
        };
        self.sink.write(&shard.encode())?;
        self.first += count as u32;
        self.offsets = shard.offsets;
        self.offsets.clear();
        self.offsets.push(0);
        self.targets = shard.targets;
        self.targets.clear();
        Ok(())
    }

    fn finish(mut self) -> Result<(FileRef, u32, u64)> {
        while self.first < self.article_count {
            self.flush()?;
        }
        self.sink.finish()
    }
}

/// `linktarget` rows that resolve to an article, searchable by `lt_id`.
struct LinkTargets {
    ids: Vec<u64>,
    ordinals: Vec<u32>,
}

impl LinkTargets {
    fn load(path: &Path, pages: &PageTable) -> Result<Self> {
        let mut dump = open_dump(path, "linktarget")?;
        let mut progress = Progress::new("linktarget");
        let mut row = Row::new();
        let mut columns = None;
        let mut pairs: Vec<(u64, u32)> = Vec::new();
        while dump.next_row(&mut row)? {
            let (c_id, c_ns, c_title) = match columns {
                Some(found) => found,
                None => {
                    let found = (
                        dump.column("lt_id")?,
                        dump.column("lt_namespace")?,
                        dump.column("lt_title")?,
                    );
                    columns = Some(found);
                    found
                }
            };
            if dump.rows_read() & 0xffff == 0 {
                progress.tick(|| {
                    format!(
                        "{} rows, {} resolvable",
                        human_count(dump.rows_read()),
                        human_count(pairs.len() as u64)
                    )
                });
            }
            if row.i64(c_ns)? != MAIN_NAMESPACE {
                continue;
            }
            let title = row.bytes(c_title)?.context("lt_title is NULL")?;
            let Some(page) = pages.find(title) else {
                continue; // red link
            };
            let ordinal = pages.resolved_ordinal(page);
            if ordinal != NONE {
                pairs.push((row.u64(c_id)?, ordinal));
            }
        }
        pairs.sort_unstable();
        ensure!(
            pairs.windows(2).all(|pair| pair[0].0 != pair[1].0),
            "linktarget dump contains a duplicate lt_id"
        );
        progress.done(format!(
            "{} rows, {} resolve to an article",
            human_count(dump.rows_read()),
            human_count(pairs.len() as u64)
        ));
        let (ids, ordinals) = pairs.into_iter().unzip();
        Ok(LinkTargets { ids, ordinals })
    }

    fn get(&self, id: u64) -> u32 {
        match self.ids.binary_search(&id) {
            Ok(index) => self.ordinals[index],
            Err(_) => NONE,
        }
    }
}

fn check_input(lock: &SourceLock, dumps_dir: &Path, table: &str, verify: bool) -> Result<PathBuf> {
    let source = lock.file(table);
    let path = dumps_dir.join(&source.file);
    let metadata = fs::metadata(&path).with_context(|| {
        format!(
            "missing dump {} (run the `download` command first)",
            path.display()
        )
    })?;
    ensure!(
        metadata.len() == source.bytes,
        "{} is {} bytes but the source lock expects {}",
        path.display(),
        metadata.len(),
        source.bytes
    );
    if verify {
        let (_, sha1) = sha1_file(&path)?;
        ensure!(
            sha1.eq_ignore_ascii_case(&source.sha1),
            "{} has SHA-1 {sha1} but the source lock expects {}",
            path.display(),
            source.sha1
        );
    }
    Ok(path)
}

fn write_metadata_shards(root: &Path, pages: &PageTable, shard_size: u32) -> Result<(FileRef, u32, u64)> {
    let mut sink = ShardSink::new(root, format::DIR_METADATA, format::KIND_METADATA)?;
    let articles = pages.article_count();
    let mut first = 0u32;
    while first < articles {
        let count = shard_size.min(articles - first);
        let mut shard = MetadataShard {
            first_ordinal: first,
            page_ids: Vec::with_capacity(count as usize),
            title_offsets: Vec::with_capacity(count as usize + 1),
            titles: Vec::new(),
        };
        shard.title_offsets.push(0);
        for ordinal in first..first + count {
            let page = pages.article_page(ordinal);
            shard.page_ids.push(pages.page_id(page));
            shard.titles.extend_from_slice(pages.title(page));
            shard.title_offsets.push(shard.titles.len() as u32);
        }
        sink.write(&shard.encode())?;
        first += count;
    }
    sink.finish()
}

fn write_title_buckets(
    root: &Path,
    pages: &PageTable,
    bucket_count: u32,
) -> Result<(FileRef, u32, u64, u32)> {
    let mut members: Vec<Vec<u32>> = vec![Vec::new(); bucket_count as usize];
    let mut entries = 0u32;
    for page in 0..pages.len() as u32 {
        if pages.resolved_ordinal(page) != NONE {
            members[bucket_for(pages.title(page), bucket_count) as usize].push(page);
            entries += 1;
        }
    }
    let mut sink = ShardSink::new(root, format::DIR_TITLES, format::KIND_TITLES)?;
    for (bucket, mut bucket_pages) in members.into_iter().enumerate() {
        bucket_pages.sort_unstable_by(|&a, &b| pages.title(a).cmp(pages.title(b)));
        let mut encoded = TitleBucket {
            bucket: bucket as u32,
            ordinals: Vec::with_capacity(bucket_pages.len()),
            title_offsets: Vec::with_capacity(bucket_pages.len() + 1),
            flags: Vec::with_capacity(bucket_pages.len()),
            titles: Vec::new(),
        };
        encoded.title_offsets.push(0);
        for page in bucket_pages {
            encoded.ordinals.push(pages.resolved_ordinal(page));
            encoded.flags.push(if pages.is_redirect(page) {
                TITLE_FLAG_REDIRECT
            } else {
                0
            });
            encoded.titles.extend_from_slice(pages.title(page));
            encoded.title_offsets.push(encoded.titles.len() as u32);
        }
        sink.write(&encoded.encode())?;
    }
    let (reference, count, bytes) = sink.finish()?;
    Ok((reference, count, bytes, entries))
}

fn write_report_file(root: &Path, relative: &str, bytes: &[u8]) -> Result<FileRef> {
    write_file_atomic(&root.join(relative), bytes)?;
    Ok(FileRef {
        path: relative.to_string(),
        bytes: bytes.len() as u64,
        sha256: sha256_hex(bytes),
    })
}

fn building_dir(snapshot_dir: &Path) -> Result<PathBuf> {
    let name = snapshot_dir
        .file_name()
        .context("snapshot directory has no name")?
        .to_string_lossy();
    Ok(snapshot_dir.with_file_name(format!(".{name}.building")))
}

pub fn build(options: &BuildOptions) -> Result<BuildSummary> {
    let lock = &options.lock;
    lock.validate()?;
    ensure!(
        manifest::is_snapshot_id(&options.snapshot_id),
        "snapshot ID {:?} must be 1-64 characters of [A-Za-z0-9_-]",
        options.snapshot_id
    );
    ensure!(options.adjacency_shard_size > 0, "adjacency shard size must be positive");
    ensure!(options.metadata_shard_size > 0, "metadata shard size must be positive");
    ensure!(options.title_bucket_count > 0, "title bucket count must be positive");
    if options.snapshot_dir.exists() && !options.force {
        bail!(
            "{} already exists; published snapshots are immutable. Choose a new \
             --snapshot-id, or pass --force to replace an unpublished local build.",
            options.snapshot_dir.display()
        );
    }
    let start_title = normalize_title(&options.start_title)
        .with_context(|| format!("start title {:?} is not a valid title", options.start_title))?;

    eprintln!("Checking inputs for {} {}", lock.wiki, lock.dump_date);
    let mut inputs = BTreeMap::new();
    for table in TABLES {
        let path = check_input(lock, &options.dumps_dir, table, options.verify_inputs)?;
        inputs.insert(table, path);
    }

    let out = building_dir(&options.snapshot_dir)?;
    if out.exists() {
        fs::remove_dir_all(&out).with_context(|| format!("clearing {}", out.display()))?;
    }
    fs::create_dir_all(&out).with_context(|| format!("creating {}", out.display()))?;
    if options.work_dir.exists() {
        fs::remove_dir_all(&options.work_dir)
            .with_context(|| format!("clearing {}", options.work_dir.display()))?;
    }

    eprintln!("Reading pages");
    let mut pages = PageTable::load(&mut open_dump(&inputs["page"], "page")?)?;
    eprintln!("Reading redirects");
    pages.load_redirects(&mut open_dump(&inputs["redirect"], "redirect")?)?;
    let redirects = pages.resolve_redirects();
    eprintln!(
        "  {} redirects: {} aliases, {} unresolved ({} without a row, {} without a usable \
         target, {} in broken chains)",
        human_count(redirects.redirect_pages as u64),
        human_count(redirects.aliases as u64),
        human_count(redirects.unresolved() as u64),
        human_count(redirects.missing_row as u64),
        human_count(redirects.no_usable_target as u64),
        human_count(redirects.unresolved_chain as u64),
    );
    let article_count = pages.article_count();

    let start_ordinal = pages
        .find(start_title.as_bytes())
        .map(|page| pages.resolved_ordinal(page))
        .filter(|&ordinal| ordinal != NONE)
        .with_context(|| format!("start article {start_title:?} is not in this snapshot"))?;
    // Record the canonical title even when the option named a redirect.
    let start_title = String::from_utf8_lossy(pages.article_title(start_ordinal)).into_owned();

    let invalid_utf8 = (0..pages.len() as u32)
        .filter(|&page| std::str::from_utf8(pages.title(page)).is_err())
        .count();
    if invalid_utf8 > 0 {
        eprintln!(
            "  warning: {invalid_utf8} titles are not valid UTF-8 and cannot be looked up by name"
        );
    }

    eprintln!("Writing metadata shards and title buckets");
    let (metadata_index, metadata_count, metadata_bytes) =
        write_metadata_shards(&out, &pages, options.metadata_shard_size)?;
    let (titles_index, title_bucket_count, titles_bytes, title_entries) =
        write_title_buckets(&out, &pages, options.title_bucket_count)?;
    ensure!(
        title_entries == article_count + redirects.aliases,
        "title index has {title_entries} entries but {} were expected",
        article_count + redirects.aliases
    );

    eprintln!("Reading link targets");
    let link_targets = LinkTargets::load(&inputs["linktarget"], &pages)?;
    pages.release_lookup();

    eprintln!("Reading page links");
    let mut source_by_page_id = vec![NONE; pages.max_page_id() as usize + 1];
    for ordinal in 0..article_count {
        source_by_page_id[pages.page_id(pages.article_page(ordinal)) as usize] = ordinal;
    }
    let mut links = LinkStats::default();
    let mut sorter = EdgeSorter::new(&options.work_dir, options.sort_capacity_edges)?;
    {
        let mut dump = open_dump(&inputs["pagelinks"], "pagelinks")?;
        let mut progress = Progress::new("pagelinks");
        let mut row = Row::new();
        let mut columns = None;
        // Rows arrive grouped by target, so remember the last lookup.
        let mut last_target_id = u64::MAX;
        let mut last_target = NONE;
        while dump.next_row(&mut row)? {
            let (c_from, c_ns, c_target) = match columns {
                Some(found) => found,
                None => {
                    let found = (
                        dump.column("pl_from")?,
                        dump.column("pl_from_namespace")?,
                        dump.column("pl_target_id")?,
                    );
                    columns = Some(found);
                    found
                }
            };
            links.rows += 1;
            if links.rows & 0xf_ffff == 0 {
                progress.tick(|| {
                    format!(
                        "{} rows, {} edges kept, {} sort runs",
                        human_count(links.rows),
                        human_count(sorter.pushed()),
                        sorter.run_count()
                    )
                });
            }
            if row.i64(c_ns)? != MAIN_NAMESPACE {
                links.source_other_namespace += 1;
                continue;
            }
            let target_id = row.u64(c_target)?;
            if target_id != last_target_id {
                last_target_id = target_id;
                last_target = link_targets.get(target_id);
            }
            if last_target == NONE {
                links.target_unresolved += 1;
                continue;
            }
            let source = usize::try_from(row.u64(c_from)?)
                .ok()
                .and_then(|id| source_by_page_id.get(id).copied())
                .unwrap_or(NONE);
            if source == NONE {
                links.source_not_article += 1;
                continue;
            }
            if source == last_target {
                links.self_links += 1;
                continue;
            }
            sorter.push(source, last_target)?;
        }
        links.emitted = sorter.pushed();
        progress.done(format!(
            "{} rows, {} edges kept",
            human_count(links.rows),
            human_count(links.emitted)
        ));
    }
    drop(source_by_page_id);
    drop(link_targets);

    eprintln!("Merging sorted edges into adjacency shards");
    let mut merged = sorter.finish()?;
    let mut adjacency = AdjacencyWriter::new(
        ShardSink::new(&out, format::DIR_ADJACENCY, format::KIND_ADJACENCY)?,
        options.adjacency_shard_size,
        article_count,
    );
    let mut graph = CsrBuilder::new(article_count);
    let mut progress = Progress::new("merge");
    while let Some((source, target)) = merged.next_edge()? {
        adjacency.push(source, target)?;
        graph.push(source, target);
        links.unique += 1;
        if links.unique & 0xf_ffff == 0 {
            progress.tick(|| format!("{} unique edges", human_count(links.unique)));
        }
    }
    drop(merged);
    let (adjacency_index, adjacency_count, adjacency_bytes) = adjacency.finish()?;
    progress.done(format!("{} unique edges", human_count(links.unique)));
    let _ = fs::remove_dir_all(&options.work_dir);

    eprintln!("Analyzing connectivity");
    let graph = graph.finish();
    let analysis = connectivity::analyze(&graph, start_ordinal);
    let title_of =
        |ordinal: u32| String::from_utf8_lossy(pages.article_title(ordinal)).into_owned();
    let report = connectivity::build_report(
        &options.snapshot_id,
        &graph,
        start_ordinal,
        &analysis,
        &title_of,
    );
    drop(graph);

    let mut reports = BTreeMap::new();
    let mut report_bytes = 0u64;
    for (name, path, bytes) in [
        (
            connectivity::REPORT_CONNECTIVITY,
            connectivity::PATH_CONNECTIVITY,
            manifest::to_pretty_json(&report)?,
        ),
        (
            connectivity::REPORT_ZERO_INDEGREE,
            connectivity::PATH_ZERO_INDEGREE,
            connectivity::encode_ordinal_list(&analysis.zero_indegree),
        ),
        (
            connectivity::REPORT_ISOLATED,
            connectivity::PATH_ISOLATED,
            connectivity::encode_ordinal_list(&analysis.isolated),
        ),
        (
            connectivity::REPORT_UNREACHABLE,
            connectivity::PATH_UNREACHABLE,
            connectivity::encode_ordinal_list(&analysis.unreachable_from_start),
        ),
    ] {
        report_bytes += bytes.len() as u64;
        reports.insert(name.to_string(), write_report_file(&out, path, &bytes)?);
    }

    let manifest = Manifest {
        schema_version: SCHEMA_VERSION,
        snapshot_id: options.snapshot_id.clone(),
        wiki: lock.wiki.clone(),
        dump_date: lock.dump_date.clone(),
        generator: Generator {
            name: env!("CARGO_PKG_NAME").to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
        sources: TABLES
            .iter()
            .map(|table| {
                let source = lock.file(table);
                ManifestSource {
                    table: table.to_string(),
                    file: source.file.clone(),
                    bytes: source.bytes,
                    sha1: source.sha1.to_ascii_lowercase(),
                }
            })
            .collect(),
        counts: Counts {
            articles: article_count,
            edges: links.unique,
            redirect_aliases: redirects.aliases,
            unresolved_redirects: redirects.unresolved(),
            title_entries,
        },
        start_article: StartArticle {
            title: start_title,
            ordinal: start_ordinal,
        },
        adjacency: RangeShards {
            dir: format::DIR_ADJACENCY.to_string(),
            shard_size: options.adjacency_shard_size,
            shard_count: adjacency_count,
            index: adjacency_index,
        },
        metadata: RangeShards {
            dir: format::DIR_METADATA.to_string(),
            shard_size: options.metadata_shard_size,
            shard_count: metadata_count,
            index: metadata_index,
        },
        titles: TitleBuckets {
            dir: format::DIR_TITLES.to_string(),
            bucket_count: title_bucket_count,
            hash: TITLE_HASH_NAME.to_string(),
            index: titles_index,
        },
        reports,
    };
    // The manifest is written last: its presence marks a complete snapshot.
    let manifest_bytes = manifest.to_bytes()?;
    write_file_atomic(&out.join(MANIFEST_FILE), &manifest_bytes)?;

    if options.snapshot_dir.exists() {
        fs::remove_dir_all(&options.snapshot_dir)
            .with_context(|| format!("replacing {}", options.snapshot_dir.display()))?;
    }
    fs::rename(&out, &options.snapshot_dir).with_context(|| {
        format!(
            "moving {} to {}",
            out.display(),
            options.snapshot_dir.display()
        )
    })?;

    let total_bytes =
        adjacency_bytes + metadata_bytes + titles_bytes + report_bytes + manifest_bytes.len() as u64;
    // Shards, three index files, four reports, and the manifest.
    let file_count =
        adjacency_count as u64 + metadata_count as u64 + title_bucket_count as u64 + 3 + 4 + 1;
    eprintln!(
        "Built snapshot {}: {} articles, {} edges, {} title entries, {} files, {}",
        options.snapshot_id,
        human_count(article_count as u64),
        human_count(links.unique),
        human_count(title_entries as u64),
        human_count(file_count),
        human_bytes(total_bytes)
    );
    eprintln!(
        "  start {:?}: {} reachable, {} unreachable; {} zero-indegree, {} isolated; {} strongly \
         connected components (largest {})",
        manifest.start_article.title,
        human_count(analysis.reachable_from_start as u64),
        human_count(analysis.unreachable_from_start.len() as u64),
        human_count(analysis.zero_indegree.len() as u64),
        human_count(analysis.isolated.len() as u64),
        human_count(analysis.component_count as u64),
        human_count(analysis.largest_component as u64),
    );

    Ok(BuildSummary {
        manifest_sha256: sha256_hex(&manifest_bytes),
        manifest,
        redirects,
        links,
        total_bytes,
        file_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(root: &Path, count: u32) -> Vec<AdjacencyShard> {
        (0..count)
            .map(|i| {
                let bytes = fs::read(root.join(format::shard_path(format::DIR_ADJACENCY, i))).unwrap();
                AdjacencyShard::decode(&bytes).unwrap()
            })
            .collect()
    }

    #[test]
    fn adjacency_writer_emits_every_shard_including_empty_ones() {
        let dir = tempfile::tempdir().unwrap();
        let sink = ShardSink::new(dir.path(), format::DIR_ADJACENCY, format::KIND_ADJACENCY).unwrap();
        // 11 articles in shards of 4: ranges [0,4), [4,8), [8,11).
        let mut writer = AdjacencyWriter::new(sink, 4, 11);
        for (source, target) in [(1, 0), (1, 5), (3, 2), (9, 1)] {
            writer.push(source, target).unwrap();
        }
        let (index, count, _) = writer.finish().unwrap();
        assert_eq!(count, 3);
        assert_eq!(index.path, "adjacency/index.bin");

        let shards = decode_all(dir.path(), count);
        assert_eq!(shards[0].first_ordinal, 0);
        assert_eq!(shards[0].offsets, vec![0, 0, 2, 2, 3]);
        assert_eq!(shards[0].targets, vec![0, 5, 2]);
        assert_eq!(shards[1].first_ordinal, 4);
        assert_eq!(shards[1].offsets, vec![0, 0, 0, 0, 0]);
        assert!(shards[1].targets.is_empty());
        assert_eq!(shards[2].first_ordinal, 8);
        assert_eq!(shards[2].count(), 3);
        assert_eq!(shards[2].offsets, vec![0, 0, 1, 1]);
        assert_eq!(shards[2].targets, vec![1]);

        let decoded_index =
            ShardIndex::decode(&fs::read(dir.path().join(&index.path)).unwrap()).unwrap();
        assert_eq!(decoded_index.kind, format::KIND_ADJACENCY);
        assert_eq!(decoded_index.entries.len(), 3);
        for (i, entry) in decoded_index.entries.iter().enumerate() {
            let bytes =
                fs::read(dir.path().join(format::shard_path(format::DIR_ADJACENCY, i as u32)))
                    .unwrap();
            assert_eq!(entry.bytes as usize, bytes.len());
            assert_eq!(entry.sha256, sha256(&bytes));
        }
    }

    #[test]
    fn adjacency_writer_handles_no_edges_and_exact_multiples() {
        let dir = tempfile::tempdir().unwrap();
        let sink = ShardSink::new(dir.path(), format::DIR_ADJACENCY, format::KIND_ADJACENCY).unwrap();
        let writer = AdjacencyWriter::new(sink, 4, 8);
        let (_, count, _) = writer.finish().unwrap();
        assert_eq!(count, 2);
        let shards = decode_all(dir.path(), count);
        assert_eq!(shards[1].first_ordinal, 4);
        assert_eq!(shards[1].count(), 4);
    }
}
