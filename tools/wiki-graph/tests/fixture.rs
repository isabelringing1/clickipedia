//! End-to-end tests over the hand-written fixture wiki.
//!
//! `fixtures/tiny/expected.json` is written by hand and is also read by the
//! browser client tests, so these tests pin the builder to the same graph the
//! browser expects.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;

use wiki_graph::build::{build, BuildOptions, BuildSummary};
use wiki_graph::connectivity::ConnectivityReport;
use wiki_graph::fixture::{
    build_fixture, diff_trees, fixture_dir, fixture_dumps_dir, fixture_lock, fixture_options,
    fixture_public_dir, read_tree, write_latest, FIXTURE_DATE, FIXTURE_SOURCE_FILE,
};
use wiki_graph::format::{self, ShardIndex};
use wiki_graph::manifest::{self, Latest, Manifest, SourceFile, SourceLock, SNAPSHOTS_DIR, TABLES};
use wiki_graph::snapshot::SnapshotReader;
use wiki_graph::sql::{open_dump, Row};
use wiki_graph::util::{sha1_file, sha256_hex};
use wiki_graph::verify::{compare, compare_snapshots, verify, Thresholds, VerifyOptions};

fn expected() -> Value {
    let text = fs::read_to_string(fixture_dir().join("expected.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn u32s(value: &Value) -> Vec<u32> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u32)
        .collect()
}

struct Built {
    _scratch: tempfile::TempDir,
    public: PathBuf,
    snapshot: PathBuf,
    summary: BuildSummary,
}

fn build_with(customize: impl FnOnce(&mut BuildOptions)) -> Built {
    let scratch = tempfile::tempdir().unwrap();
    let public = scratch.path().join("public");
    let dumps = fixture_dumps_dir();
    let mut options = fixture_options(
        fixture_lock(&dumps).unwrap(),
        &dumps,
        &scratch.path().join("work"),
        &public,
    );
    customize(&mut options);
    let snapshot = options.snapshot_dir.clone();
    let summary = build(&options).unwrap();
    Built {
        _scratch: scratch,
        public,
        snapshot,
        summary,
    }
}

fn build_default() -> Built {
    build_with(|_| {})
}

fn verify_options(snapshot: &Path) -> VerifyOptions {
    VerifyOptions {
        snapshot_dir: snapshot.to_path_buf(),
        quick: false,
        expect_links: Vec::new(),
        same_as: None,
    }
}

fn read_ordinals(snapshot: &Path, relative: &str) -> Vec<u32> {
    fs::read(snapshot.join(relative))
        .unwrap()
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()))
        .collect()
}

#[test]
fn fixture_builds_the_expected_graph() {
    let expected = expected();
    let built = build_default();
    let reader = SnapshotReader::open(&built.snapshot).unwrap();
    let manifest = reader.manifest();

    assert_eq!(manifest.snapshot_id, expected["snapshotId"].as_str().unwrap());
    assert_eq!(manifest.wiki, expected["wiki"].as_str().unwrap());
    assert_eq!(manifest.dump_date, expected["dumpDate"].as_str().unwrap());
    assert_eq!(
        serde_json::to_value(&manifest.counts).unwrap(),
        expected["counts"]
    );
    assert_eq!(
        serde_json::to_value(&manifest.start_article).unwrap(),
        expected["startArticle"]
    );
    assert_eq!(
        manifest.adjacency.shard_size as u64,
        expected["format"]["adjacencyShardSize"].as_u64().unwrap()
    );
    assert_eq!(manifest.adjacency.shard_count, 3);
    assert_eq!(
        manifest.metadata.shard_size as u64,
        expected["format"]["metadataShardSize"].as_u64().unwrap()
    );
    assert_eq!(manifest.metadata.shard_count, 4);
    assert_eq!(
        manifest.titles.bucket_count as u64,
        expected["format"]["titleBuckets"].as_u64().unwrap()
    );
    assert_eq!(manifest.sources.len(), 4);

    let articles = expected["articles"].as_array().unwrap();
    assert_eq!(articles.len() as u32, manifest.counts.articles);
    for article in articles {
        let ordinal = article["ordinal"].as_u64().unwrap() as u32;
        let title = article["title"].as_str().unwrap();
        let stored = reader.article(ordinal).unwrap();
        assert_eq!(stored.title, title);
        assert_eq!(stored.page_id as u64, article["pageId"].as_u64().unwrap());
        assert_eq!(
            reader.neighbors(ordinal).unwrap(),
            u32s(&article["links"]),
            "links of {title}"
        );
        let found = reader.lookup_title(title).unwrap().unwrap();
        assert_eq!(found.ordinal, ordinal, "lookup of {title}");
        assert!(!found.is_redirect);
    }
    assert!(reader.article(manifest.counts.articles).is_err());
    assert!(reader.neighbors(manifest.counts.articles).is_err());

    for (alias, ordinal) in expected["aliases"].as_object().unwrap() {
        let found = reader.lookup_title(alias).unwrap().unwrap();
        assert_eq!(found.ordinal as u64, ordinal.as_u64().unwrap(), "alias {alias}");
        assert!(found.is_redirect, "alias {alias}");
    }
    for title in expected["notFound"].as_array().unwrap() {
        let title = title.as_str().unwrap();
        assert_eq!(reader.lookup_title(title).unwrap(), None, "{title}");
    }
    for lookup in expected["lookups"].as_array().unwrap() {
        let input = lookup["input"].as_str().unwrap();
        let found = reader.lookup_title(input).unwrap().unwrap();
        assert_eq!(found.ordinal as u64, lookup["ordinal"].as_u64().unwrap(), "{input}");
        assert_eq!(found.is_redirect, lookup["isRedirect"].as_bool().unwrap(), "{input}");
    }

    let redirects = &expected["redirectStats"];
    let stats = &built.summary.redirects;
    assert_eq!(stats.redirect_pages as u64, redirects["redirectPages"].as_u64().unwrap());
    assert_eq!(stats.aliases as u64, redirects["aliases"].as_u64().unwrap());
    assert_eq!(stats.missing_row as u64, redirects["missingRow"].as_u64().unwrap());
    assert_eq!(stats.no_usable_target as u64, redirects["noUsableTarget"].as_u64().unwrap());
    assert_eq!(stats.unresolved_chain as u64, redirects["unresolvedChain"].as_u64().unwrap());

    let links = &expected["linkStats"];
    let stats = &built.summary.links;
    assert_eq!(stats.rows, links["rows"].as_u64().unwrap());
    assert_eq!(stats.source_other_namespace, links["sourceOtherNamespace"].as_u64().unwrap());
    assert_eq!(stats.target_unresolved, links["targetUnresolved"].as_u64().unwrap());
    assert_eq!(stats.source_not_article, links["sourceNotArticle"].as_u64().unwrap());
    assert_eq!(stats.self_links, links["selfLinks"].as_u64().unwrap());
    assert_eq!(stats.emitted, links["emitted"].as_u64().unwrap());
    assert_eq!(stats.unique, links["unique"].as_u64().unwrap());
}

#[test]
fn fixture_connectivity_report_matches_expectations() {
    let expected = expected();
    let connectivity = &expected["connectivity"];
    let built = build_default();
    let manifest = &built.summary.manifest;

    let report: ConnectivityReport = serde_json::from_slice(
        &fs::read(built.snapshot.join(&manifest.reports["connectivity"].path)).unwrap(),
    )
    .unwrap();
    assert_eq!(report.articles, 10);
    assert_eq!(report.edges, 12);
    assert_eq!(report.start.title, "Incremental_game");
    assert_eq!(report.start.reachable as u64, connectivity["reachableFromStart"].as_u64().unwrap());
    assert_eq!(report.start.unreachable, 4);
    assert_eq!(
        report.start.in_largest_component,
        connectivity["startInLargestComponent"].as_bool().unwrap()
    );
    let components = &report.strongly_connected_components;
    assert_eq!(components.count as u64, connectivity["componentCount"].as_u64().unwrap());
    assert_eq!(components.largest as u64, connectivity["largestComponent"].as_u64().unwrap());
    assert_eq!(components.top_sizes, u32s(&connectivity["topComponentSizes"]));
    assert_eq!(
        report.degrees.max_out.ordinal as u64,
        connectivity["maxOutDegree"]["ordinal"].as_u64().unwrap()
    );
    assert_eq!(
        report.degrees.max_out.degree,
        connectivity["maxOutDegree"]["degree"].as_u64().unwrap()
    );
    assert_eq!(
        report.degrees.max_in.ordinal as u64,
        connectivity["maxInDegree"]["ordinal"].as_u64().unwrap()
    );
    assert_eq!(
        report.degrees.max_in.degree,
        connectivity["maxInDegree"]["degree"].as_u64().unwrap()
    );

    for (list, name, key) in [
        (&report.zero_indegree, "zeroIndegree", "zeroIndegree"),
        (&report.isolated, "isolated", "isolated"),
        (&report.unreachable_from_start, "unreachableFromStart", "unreachableFromStart"),
    ] {
        let ordinals = u32s(&connectivity[key]);
        assert_eq!(list.count as usize, ordinals.len(), "{name}");
        assert_eq!(list.list, manifest.reports[name].path);
        assert_eq!(read_ordinals(&built.snapshot, &list.list), ordinals, "{name}");
        let sampled: Vec<u32> = list.sample.iter().map(|a| a.ordinal).collect();
        assert_eq!(sampled, ordinals, "{name} sample");
    }
    assert_eq!(report.zero_indegree.sample[0].title, "Orphan");
    assert_eq!(report.isolated.sample[0].title, "Island");
}

/// Recomputes the edge set with plain hash maps straight from the SQL, then
/// requires the emitted adjacency to be exactly that set: every emitted edge
/// is an input hyperlink after redirect resolution, and none is missing.
#[test]
fn every_emitted_edge_is_an_input_hyperlink_after_redirect_resolution() {
    fn rows(table: &str) -> Vec<Vec<Option<Vec<u8>>>> {
        let path = fixture_dumps_dir().join(format!("tinywiki-{FIXTURE_DATE}-{table}.sql"));
        let mut dump = open_dump(&path, table).unwrap();
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
    let text = |field: &Option<Vec<u8>>| String::from_utf8(field.clone().unwrap()).unwrap();
    let number = |field: &Option<Vec<u8>>| text(field).parse::<i64>().unwrap();

    // Namespace-0 pages by title and by ID.
    let mut by_title: HashMap<String, (i64, bool)> = HashMap::new();
    let mut by_id: HashMap<i64, (String, bool)> = HashMap::new();
    for row in rows("page") {
        if number(&row[1]) == 0 {
            let (id, title, redirect) = (number(&row[0]), text(&row[2]), number(&row[3]) != 0);
            by_title.insert(title.clone(), (id, redirect));
            by_id.insert(id, (title, redirect));
        }
    }
    let mut redirect_rows: HashMap<i64, (i64, String, String)> = HashMap::new();
    for row in rows("redirect") {
        let interwiki = row[3].clone().map(|b| String::from_utf8(b).unwrap()).unwrap_or_default();
        redirect_rows.insert(number(&row[0]), (number(&row[1]), text(&row[2]), interwiki));
    }
    let resolve = |title: &str| -> Option<String> {
        let mut current = title.to_string();
        let mut visited = HashSet::new();
        loop {
            let &(id, is_redirect) = by_title.get(&current)?;
            if !is_redirect {
                return Some(current);
            }
            if !visited.insert(current.clone()) {
                return None;
            }
            let (namespace, target, interwiki) = redirect_rows.get(&id)?;
            if *namespace != 0 || !interwiki.is_empty() {
                return None;
            }
            current = target.clone();
        }
    };
    let mut link_targets: HashMap<i64, (i64, String)> = HashMap::new();
    for row in rows("linktarget") {
        link_targets.insert(number(&row[0]), (number(&row[1]), text(&row[2])));
    }
    let mut reference: BTreeSet<(String, String)> = BTreeSet::new();
    for row in rows("pagelinks") {
        if number(&row[1]) != 0 {
            continue;
        }
        let Some((source, false)) = by_id.get(&number(&row[0])).cloned() else {
            continue;
        };
        let Some((0, target_title)) = link_targets.get(&number(&row[2])).cloned() else {
            continue;
        };
        if let Some(target) = resolve(&target_title) {
            if target != source {
                reference.insert((source, target));
            }
        }
    }

    let built = build_default();
    let reader = SnapshotReader::open(&built.snapshot).unwrap();
    let articles = reader.manifest().counts.articles;
    let mut emitted: BTreeSet<(String, String)> = BTreeSet::new();
    let mut emitted_count = 0u64;
    for ordinal in 0..articles {
        let source = reader.article(ordinal).unwrap().title;
        for target in reader.neighbors(ordinal).unwrap() {
            assert!(target < articles, "target ordinal {target} does not exist");
            emitted.insert((source.clone(), reader.article(target).unwrap().title));
            emitted_count += 1;
        }
    }
    assert_eq!(emitted, reference);
    assert_eq!(emitted_count, reference.len() as u64, "no duplicate edges");
    assert_eq!(emitted_count, reader.manifest().counts.edges);
}

#[test]
fn checked_in_fixture_snapshot_is_current() {
    let built = build_default();
    write_latest(&built.public, FIXTURE_DATE).unwrap();
    let differences = diff_trees(
        &read_tree(&built.public).unwrap(),
        &read_tree(&fixture_public_dir()).unwrap(),
    );
    assert!(
        differences.is_empty(),
        "run `cargo run -- fixture` and commit the result:\n{}",
        differences.join("\n")
    );
    let lock = manifest::to_pretty_json(&fixture_lock(&fixture_dumps_dir()).unwrap()).unwrap();
    assert_eq!(
        fs::read(fixture_dir().join(FIXTURE_SOURCE_FILE)).unwrap(),
        lock,
        "fixtures/tiny/source.json is stale"
    );
}

#[test]
fn build_is_deterministic_and_independent_of_sort_memory() {
    let reference = read_tree(&build_default().snapshot).unwrap();
    assert!(reference.contains_key("manifest.json"));
    for capacity in [1, 2, 7, 1_000_000] {
        let built = build_with(|options| options.sort_capacity_edges = capacity);
        let differences = diff_trees(&reference, &read_tree(&built.snapshot).unwrap());
        assert!(differences.is_empty(), "capacity {capacity}: {differences:?}");
    }
}

#[test]
fn shard_sizes_change_layout_but_not_the_graph() {
    let expected = expected();
    for (adjacency, metadata, buckets) in [(1, 1, 1), (3, 10, 7), (10, 4, 64), (4096, 4096, 8192)] {
        let built = build_with(|options| {
            options.adjacency_shard_size = adjacency;
            options.metadata_shard_size = metadata;
            options.title_bucket_count = buckets;
        });
        verify(&verify_options(&built.snapshot)).unwrap();
        let reader = SnapshotReader::open(&built.snapshot).unwrap();
        assert_eq!(reader.manifest().adjacency.shard_count, 10u32.div_ceil(adjacency));
        assert_eq!(reader.manifest().metadata.shard_count, 10u32.div_ceil(metadata));
        for article in expected["articles"].as_array().unwrap() {
            let ordinal = article["ordinal"].as_u64().unwrap() as u32;
            let title = article["title"].as_str().unwrap();
            assert_eq!(reader.article(ordinal).unwrap().title, title);
            assert_eq!(reader.neighbors(ordinal).unwrap(), u32s(&article["links"]));
            assert_eq!(reader.lookup_title(title).unwrap().unwrap().ordinal, ordinal);
        }
    }
}

#[test]
fn gzipped_dumps_produce_identical_shards() {
    let scratch = tempfile::tempdir().unwrap();
    let dumps = scratch.path().join("dumps");
    fs::create_dir_all(&dumps).unwrap();
    let mut files = BTreeMap::new();
    for table in TABLES {
        let plain = fs::read(
            fixture_dumps_dir().join(format!("tinywiki-{FIXTURE_DATE}-{table}.sql")),
        )
        .unwrap();
        let name = format!("tinywiki-{FIXTURE_DATE}-{table}.sql.gz");
        // Two concatenated gzip members, as produced by parallel compressors.
        let split = plain.len() / 2;
        let mut bytes = Vec::new();
        for part in [&plain[..split], &plain[split..]] {
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(part).unwrap();
            bytes.extend(encoder.finish().unwrap());
        }
        fs::write(dumps.join(&name), &bytes).unwrap();
        let (length, sha1) = sha1_file(&dumps.join(&name)).unwrap();
        files.insert(
            table.to_string(),
            SourceFile {
                url: format!("fixture://{name}"),
                file: name,
                bytes: length,
                sha1,
                md5: None,
            },
        );
    }
    let lock = SourceLock {
        schema_version: manifest::SCHEMA_VERSION,
        wiki: "tinywiki".into(),
        dump_date: FIXTURE_DATE.into(),
        files,
    };
    let public = scratch.path().join("public");
    let options = fixture_options(lock, &dumps, &scratch.path().join("work"), &public);
    build(&options).unwrap();

    let gz = read_tree(&options.snapshot_dir).unwrap();
    let plain = read_tree(&build_default().snapshot).unwrap();
    // Only the manifest may differ: it records the input file names and hashes.
    let differences = diff_trees(&plain, &gz);
    assert_eq!(differences, ["differs: manifest.json"]);
}

#[test]
fn verify_accepts_the_fixture_and_expected_links() {
    let built = build_default();
    let mut options = verify_options(&built.snapshot);
    options.expect_links = vec![
        ("Incremental game".into(), "Cookie Clicker".into()),
        // An alias on either side resolves before the link is checked.
        ("cookie Clicker".into(), "Idle game".into()),
        ("Orphan".into(), "Section redirect".into()),
    ];
    let outcome = verify(&options).unwrap();
    assert_eq!(outcome.manifest_sha256, built.summary.manifest_sha256);
    // manifest + 3 indexes + 3 adjacency + 4 metadata + 4 title + 4 reports
    assert_eq!(outcome.files, 19);
    assert_eq!(outcome.files, built.summary.file_count);
    assert_eq!(outcome.bytes, built.summary.total_bytes);

    options.quick = true;
    verify(&options).unwrap();

    options.expect_links = vec![("Island".into(), "Cookie Clicker".into())];
    assert!(verify(&options).is_err());
    options.expect_links = vec![("Incremental game".into(), "No such page".into())];
    assert!(verify(&options).is_err());
    // Titles are case-sensitive after the first letter.
    options.expect_links = vec![("cookie clicker".into(), "Incremental game".into())];
    assert!(verify(&options).is_err());
}

#[test]
fn verify_confirms_identical_rebuilds_and_flags_different_ones() {
    let first = build_default();
    let second = build_default();
    let mut options = verify_options(&first.snapshot);
    options.same_as = Some(second.snapshot.clone());
    verify(&options).unwrap();

    let different = build_with(|options| options.title_bucket_count = 5);
    options.same_as = Some(different.snapshot.clone());
    assert!(verify(&options).is_err());
}

#[test]
fn verify_rejects_corrupted_snapshots() {
    fn corrupt(label: &str, damage: impl FnOnce(&Path)) {
        let built = build_default();
        damage(&built.snapshot);
        for quick in [false, true] {
            let mut options = verify_options(&built.snapshot);
            options.quick = quick;
            assert!(verify(&options).is_err(), "{label} (quick: {quick}) was accepted");
        }
    }
    fn flip_last_byte(path: &Path) {
        let mut bytes = fs::read(path).unwrap();
        *bytes.last_mut().unwrap() ^= 0x01;
        fs::write(path, bytes).unwrap();
    }

    corrupt("bit flip in an adjacency shard", |dir| {
        flip_last_byte(&dir.join("adjacency/000000.bin"))
    });
    corrupt("bit flip in a metadata shard", |dir| {
        flip_last_byte(&dir.join("metadata/000001.bin"))
    });
    corrupt("bit flip in a title bucket", |dir| {
        flip_last_byte(&dir.join("titles/000002.bin"))
    });
    corrupt("bit flip in an index", |dir| {
        flip_last_byte(&dir.join("titles/index.bin"))
    });
    corrupt("truncated shard", |dir| {
        let path = dir.join("adjacency/000001.bin");
        let bytes = fs::read(&path).unwrap();
        fs::write(&path, &bytes[..bytes.len() - 4]).unwrap();
    });
    corrupt("missing shard", |dir| {
        fs::remove_file(dir.join("metadata/000003.bin")).unwrap()
    });
    corrupt("edited report", |dir| {
        let path = dir.join("reports/connectivity.json");
        let text = fs::read_to_string(&path).unwrap();
        fs::write(&path, text.replace("\"reachable\": 6", "\"reachable\": 7")).unwrap();
    });
    corrupt("edited list", |dir| {
        flip_last_byte(&dir.join("reports/zero-indegree.bin"))
    });
    corrupt("manifest with a wrong edge count", |dir| {
        let path = dir.join("manifest.json");
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"edges\": 12"));
        fs::write(&path, text.replace("\"edges\": 12", "\"edges\": 13")).unwrap();
    });
    corrupt("manifest with an unknown title hash", |dir| {
        let path = dir.join("manifest.json");
        let text = fs::read_to_string(&path).unwrap();
        fs::write(&path, text.replace("fnv1a32-fmix32", "md5")).unwrap();
    });
}

/// Hashes alone cannot catch a builder bug, because the builder computes them
/// from whatever it wrote. Rewrite a shard *and* its hashes consistently and
/// require the structural checks to object.
#[test]
fn verify_rejects_internally_consistent_but_invalid_graphs() {
    fn rewrite_adjacency(dir: &Path, edit: impl FnOnce(&mut format::AdjacencyShard)) {
        let shard_path = dir.join("adjacency/000000.bin");
        let mut shard = format::AdjacencyShard::decode(&fs::read(&shard_path).unwrap()).unwrap();
        edit(&mut shard);
        let bytes = shard.encode();
        fs::write(&shard_path, &bytes).unwrap();

        let index_path = dir.join("adjacency/index.bin");
        let mut index = ShardIndex::decode(&fs::read(&index_path).unwrap()).unwrap();
        index.entries[0].bytes = bytes.len() as u32;
        index.entries[0].sha256 = wiki_graph::util::sha256(&bytes);
        let index_bytes = index.encode();
        fs::write(&index_path, &index_bytes).unwrap();

        let (mut manifest, _) = Manifest::load(dir).unwrap();
        manifest.adjacency.index.bytes = index_bytes.len() as u64;
        manifest.adjacency.index.sha256 = sha256_hex(&index_bytes);
        fs::write(dir.join("manifest.json"), manifest.to_bytes().unwrap()).unwrap();
    }
    fn rejected(label: &str, edit: impl FnOnce(&mut format::AdjacencyShard)) {
        let built = build_default();
        rewrite_adjacency(&built.snapshot, edit);
        let error = match verify(&verify_options(&built.snapshot)) {
            Ok(_) => panic!("{label}: verify accepted an invalid graph"),
            Err(error) => error,
        };
        // The failure must come from a structural check, not a hash mismatch.
        assert!(!format!("{error:#}").contains("SHA-256"), "{label}: {error:#}");
    }

    // Ordinal 0 links to [1, 2, 4].
    rejected("target out of range", |shard| shard.targets[2] = 10);
    rejected("self link", |shard| shard.targets[0] = 0);
    rejected("duplicate target", |shard| shard.targets[1] = 1);
    rejected("unsorted targets", |shard| shard.targets.swap(0, 2));
    // Dropping 1 -> 0 leaves a well-formed graph, but it changes the edge
    // count and the connectivity report.
    rejected("removed link", |shard| {
        shard.targets.remove(3);
        for offset in &mut shard.offsets[2..] {
            *offset -= 1;
        }
    });

    // Swapping one valid link for another valid link (0 -> 4 becomes 0 -> 3)
    // leaves every structural property and every report total intact. A
    // snapshot cannot be checked against the original dumps from its own
    // contents, so this is only detectable by comparing with a clean rebuild.
    let tampered = build_default();
    rewrite_adjacency(&tampered.snapshot, |shard| shard.targets[2] = 3);
    let clean = build_default();
    let mut options = verify_options(&tampered.snapshot);
    options.same_as = Some(clean.snapshot.clone());
    let error = verify(&options).unwrap_err();
    assert!(format!("{error:#}").contains("not identical"), "{error:#}");
}

#[test]
fn build_refuses_to_replace_a_snapshot_without_force() {
    let built = build_default();
    let dumps = fixture_dumps_dir();
    let mut options = fixture_options(
        fixture_lock(&dumps).unwrap(),
        &dumps,
        &built.public.join("../work2"),
        &built.public,
    );
    options.force = false;
    let before = read_tree(&built.snapshot).unwrap();
    let error = build(&options).err().expect("build must refuse");
    assert!(format!("{error:#}").contains("already exists"));
    assert!(diff_trees(&before, &read_tree(&built.snapshot).unwrap()).is_empty());
}

#[test]
fn build_rejects_bad_inputs() {
    // A dump whose bytes differ from the lock.
    let scratch = tempfile::tempdir().unwrap();
    let dumps = scratch.path().join("dumps");
    fs::create_dir_all(&dumps).unwrap();
    for entry in fs::read_dir(fixture_dumps_dir()).unwrap() {
        let path = entry.unwrap().path();
        fs::copy(&path, dumps.join(path.file_name().unwrap())).unwrap();
    }
    let lock = fixture_lock(&dumps).unwrap();
    let pagelinks = dumps.join(format!("tinywiki-{FIXTURE_DATE}-pagelinks.sql"));
    let text = fs::read_to_string(&pagelinks).unwrap();
    fs::write(&pagelinks, text.replace("(1,0,101)", "(1,0,110)")).unwrap();
    let options = fixture_options(
        lock.clone(),
        &dumps,
        &scratch.path().join("work"),
        &scratch.path().join("public"),
    );
    let error = build(&options).err().expect("checksum mismatch must fail");
    assert!(format!("{error:#}").contains("SHA-1"));
    assert!(!options.snapshot_dir.exists(), "no snapshot is left behind");

    // A start article that does not exist.
    let mut options = fixture_options(
        fixture_lock(&fixture_dumps_dir()).unwrap(),
        &fixture_dumps_dir(),
        &scratch.path().join("work"),
        &scratch.path().join("public"),
    );
    options.start_title = "No such article".into();
    assert!(build(&options).is_err());
    assert!(!options.snapshot_dir.exists());

    // A missing dump file.
    let empty = scratch.path().join("empty");
    fs::create_dir_all(&empty).unwrap();
    let options = fixture_options(
        lock,
        &empty,
        &scratch.path().join("work"),
        &scratch.path().join("public"),
    );
    let error = build(&options).err().expect("missing dump must fail");
    assert!(format!("{error:#}").contains("download"));
}

#[test]
fn start_title_given_as_a_redirect_resolves_to_the_article() {
    let built = build_with(|options| options.start_title = "idle game".into());
    assert_eq!(built.summary.manifest.start_article.title, "Incremental_game");
    assert_eq!(built.summary.manifest.start_article.ordinal, 0);
    verify(&verify_options(&built.snapshot)).unwrap();
}

#[test]
fn latest_points_at_the_snapshot_manifest() {
    let scratch = tempfile::tempdir().unwrap();
    let public = scratch.path().join("public");
    let summary = build_fixture(&public, &scratch.path().join("work")).unwrap();
    let latest: Latest =
        serde_json::from_slice(&fs::read(public.join("latest.json")).unwrap()).unwrap();
    assert_eq!(latest.snapshot_id, FIXTURE_DATE);
    assert_eq!(latest.manifest_path, format!("{SNAPSHOTS_DIR}/{FIXTURE_DATE}/manifest.json"));
    assert_eq!(latest.manifest_sha256, summary.manifest_sha256);
    assert_eq!(
        sha256_hex(&fs::read(public.join(&latest.manifest_path)).unwrap()),
        latest.manifest_sha256
    );
    assert!(write_latest(&public, "20991231").is_err());
    assert!(write_latest(&public, "../escape").is_err());
}

#[test]
fn compare_accepts_plausible_refreshes_and_rejects_implausible_ones() {
    let built = build_default();
    let (old_manifest, _) = Manifest::load(&built.snapshot).unwrap();
    let old_report: ConnectivityReport = serde_json::from_slice(
        &fs::read(built.snapshot.join("reports/connectivity.json")).unwrap(),
    )
    .unwrap();
    let thresholds = Thresholds::default();
    let regressions = |manifest: &Manifest, report: &ConnectivityReport| -> Vec<&'static str> {
        compare_snapshots((&old_manifest, &old_report), (manifest, report), &thresholds)
            .into_iter()
            .filter(|finding| finding.regression.is_some())
            .map(|finding| finding.metric)
            .collect()
    };

    let mut newer = old_manifest.clone();
    newer.dump_date = "20260201".into();
    newer.snapshot_id = "20260201".into();
    assert!(regressions(&newer, &old_report).is_empty());

    // The same dump again is not a refresh.
    assert_eq!(regressions(&old_manifest, &old_report), ["dump date"]);

    let mut fewer_edges = newer.clone();
    fewer_edges.counts.edges = 6;
    assert_eq!(regressions(&fewer_edges, &old_report), ["edges"]);

    let mut more_articles = newer.clone();
    more_articles.counts.articles = 20;
    // Twice the articles also halves the reachable and largest-component shares.
    assert_eq!(
        regressions(&more_articles, &old_report),
        ["articles", "share reachable from start", "share in largest component"]
    );

    let mut less_reachable = old_report.clone();
    less_reachable.start.reachable = 2;
    assert_eq!(regressions(&newer, &less_reachable), ["share reachable from start"]);

    let mut more_orphans = old_report.clone();
    more_orphans.zero_indegree.count = 9;
    assert_eq!(regressions(&newer, &more_orphans), ["zero-indegree articles"]);

    let mut renamed = newer.clone();
    renamed.start_article.title = "Cookie_Clicker".into();
    assert_eq!(regressions(&renamed, &old_report), ["start article"]);

    // The directory-level command fails closed, and can be overridden.
    assert!(compare(&built.snapshot, &built.snapshot, false).is_err());
    assert!(compare(&built.snapshot, &built.snapshot, true).is_ok());
}
