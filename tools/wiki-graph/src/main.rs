use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use clap::{ArgAction, Args, Parser, Subcommand};

use wiki_graph::build::{
    self, BuildOptions, DEFAULT_ADJACENCY_SHARD_SIZE, DEFAULT_METADATA_SHARD_SIZE,
    DEFAULT_SORT_MEMORY_MB, DEFAULT_START_TITLE, DEFAULT_TITLE_BUCKETS,
};
use wiki_graph::download::{download, DownloadOptions};
use wiki_graph::fixture;
use wiki_graph::manifest::{self, SourceLock, MANIFEST_FILE, SNAPSHOTS_DIR};
use wiki_graph::resolve::{resolve, Selection, DEFAULT_BASE_URL, DEFAULT_WIKI};
use wiki_graph::util::{human_bytes, write_file_atomic};
use wiki_graph::verify::{compare, verify, VerifyOptions};

#[derive(Parser)]
#[command(
    name = "wiki-graph",
    version,
    about = "Builds browser-readable Wikipedia hyperlink graph shards for Clickipedia"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct DataDir {
    /// Directory for downloaded dumps, sort runs, and built snapshots.
    #[arg(long, env = "WIKI_GRAPH_DATA_DIR", default_value_os_t = default_data_dir())]
    data_dir: PathBuf,
}

#[derive(Subcommand)]
enum Command {
    /// Pin an exact, completed Wikimedia dump and write its source lock.
    Resolve {
        #[arg(long, default_value = DEFAULT_WIKI)]
        wiki: String,
        /// Reproduce a specific dump run (YYYYMMDD).
        #[arg(long, conflicts_with = "newest_complete")]
        date: Option<String>,
        /// Deliberately move to the newest run whose every job has finished.
        #[arg(long)]
        newest_complete: bool,
        #[arg(long, default_value = DEFAULT_BASE_URL)]
        base_url: String,
        /// Where to write the lock [default: sources/<wiki>-<date>.json]
        #[arg(long)]
        out: Option<PathBuf>,
        /// Overwrite an existing lock whose contents differ.
        #[arg(long)]
        force: bool,
    },
    /// Download the locked dump files, resuming and verifying checksums.
    Download {
        /// Source lock path, or a dump date with a lock under sources/.
        #[arg(long)]
        source: String,
        #[command(flatten)]
        data: DataDir,
        /// Simultaneous connections (Wikimedia asks for at most two).
        #[arg(long, default_value_t = 2)]
        jobs: usize,
    },
    /// Build an immutable snapshot from downloaded dumps.
    Build {
        /// Source lock path, or a dump date with a lock under sources/.
        #[arg(long)]
        source: String,
        #[command(flatten)]
        data: DataDir,
        /// Snapshot ID [default: the dump date]
        #[arg(long)]
        snapshot_id: Option<String>,
        #[arg(long, default_value = DEFAULT_START_TITLE)]
        start_title: String,
        /// Source articles per adjacency shard.
        #[arg(long, default_value_t = DEFAULT_ADJACENCY_SHARD_SIZE)]
        adjacency_shard_size: u32,
        /// Articles per metadata shard.
        #[arg(long, default_value_t = DEFAULT_METADATA_SHARD_SIZE)]
        metadata_shard_size: u32,
        /// Number of title hash buckets.
        #[arg(long, default_value_t = DEFAULT_TITLE_BUCKETS)]
        title_buckets: u32,
        /// Memory for the external edge sort buffer.
        #[arg(long, default_value_t = DEFAULT_SORT_MEMORY_MB)]
        sort_memory_mb: usize,
        /// Trust the dump files without re-hashing them.
        #[arg(long)]
        skip_input_checksums: bool,
        /// Replace an existing, unpublished local snapshot of the same ID.
        #[arg(long)]
        force: bool,
    },
    /// Check a snapshot against its manifest and recompute its reports.
    Verify {
        /// Snapshot ID under the data directory, or a snapshot directory.
        #[arg(long)]
        snapshot: String,
        #[command(flatten)]
        data: DataDir,
        /// Skip checks that load the whole graph (about 4 GiB of RAM).
        #[arg(long)]
        quick: bool,
        /// Require a link between two titles; may be repeated.
        #[arg(long, num_args = 2, value_names = ["FROM", "TO"], action = ArgAction::Append)]
        expect_link: Vec<String>,
        /// Another build that must be byte-identical (determinism check).
        #[arg(long)]
        same_as: Option<String>,
    },
    /// Fail if a new snapshot's totals moved implausibly from an old one.
    Compare {
        /// Old snapshot ID or directory.
        #[arg(long)]
        old: String,
        /// New snapshot ID or directory.
        #[arg(long)]
        new: String,
        #[command(flatten)]
        data: DataDir,
        /// Accept implausible changes after inspecting them.
        #[arg(long)]
        allow_regression: bool,
    },
    /// Point the local latest.json at a verified snapshot.
    Promote {
        /// Snapshot ID under the data directory.
        #[arg(long)]
        snapshot: String,
        #[command(flatten)]
        data: DataDir,
    },
    /// Regenerate (or with --check, validate) the checked-in test fixture.
    Fixture {
        #[arg(long)]
        check: bool,
    },
}

fn tool_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

/// The `.nosync` suffix keeps macOS from uploading tens of gigabytes of dumps
/// to iCloud when the repository lives in a synced folder such as Documents.
fn default_data_dir() -> PathBuf {
    tool_dir().join("data.nosync")
}

fn public_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("public")
}

/// Accepts a lock path, or a dump date naming `sources/enwiki-<date>.json`.
fn load_source(arg: &str) -> Result<SourceLock> {
    let path = if manifest::is_dump_date(arg) {
        tool_dir()
            .join("sources")
            .join(format!("{DEFAULT_WIKI}-{arg}.json"))
    } else {
        PathBuf::from(arg)
    };
    SourceLock::load(&path)
}

/// Accepts a snapshot directory, or a snapshot ID under the data directory.
fn snapshot_dir(arg: &str, data_dir: &Path) -> Result<PathBuf> {
    let as_path = PathBuf::from(arg);
    if as_path.join(MANIFEST_FILE).is_file() {
        return Ok(as_path);
    }
    ensure!(
        manifest::is_snapshot_id(arg),
        "{arg:?} is neither a snapshot directory nor a valid snapshot ID"
    );
    let dir = public_dir(data_dir).join(SNAPSHOTS_DIR).join(arg);
    ensure!(
        dir.join(MANIFEST_FILE).is_file(),
        "no built snapshot at {}",
        dir.display()
    );
    Ok(dir)
}

fn dumps_dir(data_dir: &Path, lock: &SourceLock) -> PathBuf {
    data_dir.join("dumps").join(&lock.wiki).join(&lock.dump_date)
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Resolve {
            wiki,
            date,
            newest_complete,
            base_url,
            out,
            force,
        } => {
            let selection = match (date, newest_complete) {
                (Some(date), false) => Selection::Date(date),
                (None, true) => Selection::NewestComplete,
                _ => bail!("pass exactly one of --date YYYYMMDD or --newest-complete"),
            };
            eprintln!("Resolving {wiki} dump from {base_url}");
            let lock = resolve(&base_url, &wiki, &selection)?;
            let path = out.unwrap_or_else(|| {
                tool_dir()
                    .join("sources")
                    .join(format!("{}-{}.json", lock.wiki, lock.dump_date))
            });
            let bytes = manifest::to_pretty_json(&lock)?;
            match fs::read(&path) {
                Ok(existing) if existing == bytes => {
                    eprintln!("Lock is unchanged: {}", path.display());
                }
                Ok(_) if !force => bail!(
                    "{} already exists with different contents: Wikimedia's files for this \
                     date changed after it was locked. Inspect the difference, then pass \
                     --force to replace the lock.",
                    path.display()
                ),
                _ => {
                    write_file_atomic(&path, &bytes)?;
                    eprintln!("Wrote {}", path.display());
                }
            }
            let total: u64 = lock.files.values().map(|file| file.bytes).sum();
            eprintln!(
                "Locked {} {}: {} files, {}",
                lock.wiki,
                lock.dump_date,
                lock.files.len(),
                human_bytes(total)
            );
            // The date on stdout lets scripts chain the next command.
            println!("{}", lock.dump_date);
            Ok(())
        }
        Command::Download { source, data, jobs } => {
            let lock = load_source(&source)?;
            download(&DownloadOptions {
                dumps_dir: dumps_dir(&data.data_dir, &lock),
                lock,
                jobs,
            })
        }
        Command::Build {
            source,
            data,
            snapshot_id,
            start_title,
            adjacency_shard_size,
            metadata_shard_size,
            title_buckets,
            sort_memory_mb,
            skip_input_checksums,
            force,
        } => {
            let lock = load_source(&source)?;
            let snapshot_id = snapshot_id.unwrap_or_else(|| lock.dump_date.clone());
            ensure!(sort_memory_mb > 0, "--sort-memory-mb must be positive");
            let summary = build::build(&BuildOptions {
                dumps_dir: dumps_dir(&data.data_dir, &lock),
                work_dir: data.data_dir.join("work").join(&snapshot_id),
                snapshot_dir: public_dir(&data.data_dir)
                    .join(SNAPSHOTS_DIR)
                    .join(&snapshot_id),
                snapshot_id,
                lock,
                start_title,
                adjacency_shard_size,
                metadata_shard_size,
                title_bucket_count: title_buckets,
                sort_capacity_edges: sort_memory_mb * (1 << 20) / 8,
                verify_inputs: !skip_input_checksums,
                force,
            })?;
            println!("{}", summary.manifest_sha256);
            Ok(())
        }
        Command::Verify {
            snapshot,
            data,
            quick,
            expect_link,
            same_as,
        } => {
            let same_as = same_as
                .map(|arg| snapshot_dir(&arg, &data.data_dir))
                .transpose()?;
            let outcome = verify(&VerifyOptions {
                snapshot_dir: snapshot_dir(&snapshot, &data.data_dir)?,
                quick,
                expect_links: expect_link
                    .chunks(2)
                    .map(|pair| (pair[0].clone(), pair[1].clone()))
                    .collect(),
                same_as,
            })?;
            println!("{}", outcome.manifest_sha256);
            Ok(())
        }
        Command::Compare {
            old,
            new,
            data,
            allow_regression,
        } => {
            compare(
                &snapshot_dir(&old, &data.data_dir)?,
                &snapshot_dir(&new, &data.data_dir)?,
                allow_regression,
            )?;
            Ok(())
        }
        Command::Promote { snapshot, data } => {
            let public = public_dir(&data.data_dir);
            let dir = public.join(SNAPSHOTS_DIR).join(&snapshot);
            ensure!(
                dir.join(MANIFEST_FILE).is_file(),
                "no built snapshot at {}",
                dir.display()
            );
            // Never point new saves at a snapshot that fails its own manifest.
            verify(&VerifyOptions {
                snapshot_dir: dir,
                quick: true,
                expect_links: Vec::new(),
                same_as: None,
            })
            .context("refusing to promote a snapshot that does not verify")?;
            let latest = fixture::write_latest(&public, &snapshot)?;
            eprintln!(
                "{} now selects snapshot {}",
                public.join(manifest::LATEST_FILE).display(),
                latest.snapshot_id
            );
            Ok(())
        }
        Command::Fixture { check } => fixture::run(check),
    }
}

fn main() {
    if let Err(error) = run(Cli::parse()) {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}
