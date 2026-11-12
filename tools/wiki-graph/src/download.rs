//! The `download` command: fetches the locked dump files with resume support
//! and verifies each against the lock's size and SHA-1.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, ensure, Context, Result};

use crate::manifest::{SourceFile, SourceLock, TABLES};
use crate::resolve::agent;
use crate::util::{human_bytes, sha1_file};

const MAX_ATTEMPTS: u32 = 8;
const COPY_BUFFER_BYTES: usize = 1 << 20;

pub struct DownloadOptions {
    pub lock: SourceLock,
    pub dumps_dir: PathBuf,
    /// Simultaneous connections. Wikimedia asks for at most two per client.
    pub jobs: usize,
}

fn partial_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

/// Returns true when `path` already holds exactly the locked content.
fn is_verified(path: &Path, source: &SourceFile) -> Result<bool> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.len() == source.bytes => {
            let (_, sha1) = sha1_file(path)?;
            Ok(sha1.eq_ignore_ascii_case(&source.sha1))
        }
        _ => Ok(false),
    }
}

/// One HTTP attempt, appending to the partial file from wherever it stands.
fn fetch_remaining(agent: &ureq::Agent, source: &SourceFile, partial: &Path) -> Result<()> {
    let mut have = fs::metadata(partial).map(|m| m.len()).unwrap_or(0);
    if have > source.bytes {
        // Longer than the locked size: it cannot be a prefix of the right file.
        fs::remove_file(partial)?;
        have = 0;
    }
    if have == source.bytes {
        return Ok(());
    }

    let mut request = agent.get(&source.url);
    if have > 0 {
        request = request.set("Range", &format!("bytes={have}-"));
    }
    let response = request
        .call()
        .with_context(|| format!("requesting {}", source.url))?;
    let resumed = response.status() == 206;
    if have > 0 && !resumed {
        // The server ignored the range; start over rather than corrupt the file.
        have = 0;
    }
    let mut file = if resumed {
        OpenOptions::new().append(true).open(partial)
    } else {
        File::create(partial)
    }
    .with_context(|| format!("opening {}", partial.display()))?;

    let mut reader = response.into_reader();
    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    let started = Instant::now();
    let mut last_report = started;
    let mut session = 0u64;
    loop {
        let n = reader
            .read(&mut buffer)
            .with_context(|| format!("downloading {}", source.file))?;
        if n == 0 {
            break;
        }
        file.write_all(&buffer[..n])
            .with_context(|| format!("writing {}", partial.display()))?;
        have += n as u64;
        session += n as u64;
        ensure!(
            have <= source.bytes,
            "{} is larger than the locked size of {} bytes",
            source.file,
            source.bytes
        );
        if last_report.elapsed() >= Duration::from_secs(15) {
            last_report = Instant::now();
            let rate = session as f64 / started.elapsed().as_secs_f64().max(0.001);
            let remaining = (source.bytes - have) as f64 / rate.max(1.0);
            eprintln!(
                "  {}: {} / {} ({:.1}%), {}/s, about {:.0} min left",
                source.file,
                human_bytes(have),
                human_bytes(source.bytes),
                have as f64 * 100.0 / source.bytes as f64,
                human_bytes(rate as u64),
                remaining / 60.0
            );
        }
    }
    file.flush()?;
    ensure!(
        have == source.bytes,
        "{} ended early at {} of {} bytes",
        source.file,
        have,
        source.bytes
    );
    Ok(())
}

fn download_one(agent: &ureq::Agent, source: &SourceFile, dumps_dir: &Path) -> Result<()> {
    let dest = dumps_dir.join(&source.file);
    if is_verified(&dest, source)? {
        eprintln!("  {}: already downloaded and verified", source.file);
        return Ok(());
    }
    let partial = partial_path(&dest);
    eprintln!(
        "  {}: downloading {} from {}",
        source.file,
        human_bytes(source.bytes),
        source.url
    );

    let mut attempt = 0;
    loop {
        attempt += 1;
        match fetch_remaining(agent, source, &partial) {
            Ok(()) => break,
            Err(error) if attempt < MAX_ATTEMPTS => {
                let wait = Duration::from_secs(5 * 2u64.pow(attempt.min(6)));
                eprintln!(
                    "  {}: attempt {attempt} failed ({error:#}); resuming in {}s",
                    source.file,
                    wait.as_secs()
                );
                thread::sleep(wait);
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "giving up on {} after {MAX_ATTEMPTS} attempts; rerun to resume",
                        source.file
                    )
                })
            }
        }
    }

    let (_, sha1) = sha1_file(&partial)?;
    if !sha1.eq_ignore_ascii_case(&source.sha1) {
        fs::remove_file(&partial)?;
        bail!(
            "{} has SHA-1 {sha1} but the source lock expects {}; the corrupt download was \
             deleted, rerun to fetch it again",
            source.file,
            source.sha1
        );
    }
    fs::rename(&partial, &dest)
        .with_context(|| format!("moving {} into place", partial.display()))?;
    eprintln!("  {}: verified SHA-1 {sha1}", source.file);
    Ok(())
}

pub fn download(options: &DownloadOptions) -> Result<()> {
    options.lock.validate()?;
    ensure!(options.jobs >= 1, "--jobs must be at least 1");
    fs::create_dir_all(&options.dumps_dir)
        .with_context(|| format!("creating {}", options.dumps_dir.display()))?;
    let total: u64 = TABLES.iter().map(|t| options.lock.file(t).bytes).sum();
    eprintln!(
        "Downloading {} {} ({}) into {}",
        options.lock.wiki,
        options.lock.dump_date,
        human_bytes(total),
        options.dumps_dir.display()
    );

    // Largest first so the longest transfer starts immediately.
    let mut pending: Vec<&SourceFile> = TABLES.iter().map(|t| options.lock.file(t)).collect();
    pending.sort_by_key(|file| file.bytes);
    let queue = Mutex::new(pending);
    let failures = Mutex::new(Vec::new());
    let agent = agent();

    thread::scope(|scope| {
        for _ in 0..options.jobs.min(TABLES.len()) {
            scope.spawn(|| loop {
                let Some(source) = queue.lock().unwrap().pop() else {
                    return;
                };
                if let Err(error) = download_one(&agent, source, &options.dumps_dir) {
                    failures
                        .lock()
                        .unwrap()
                        .push(format!("{}: {error:#}", source.file));
                }
            });
        }
    });

    let failures = failures.into_inner().unwrap();
    if !failures.is_empty() {
        bail!("download failed:\n  {}", failures.join("\n  "));
    }
    eprintln!("All four dump files are present and verified.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_for(content: &[u8]) -> SourceFile {
        use sha1::{Digest, Sha1};
        SourceFile {
            file: "t.sql.gz".into(),
            url: "http://127.0.0.1:9/unused".into(),
            bytes: content.len() as u64,
            sha1: crate::util::hex(&Sha1::digest(content)),
            md5: None,
        }
    }

    #[test]
    fn recognizes_only_exact_content_as_verified() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sql.gz");
        let source = source_for(b"hello dump");
        assert!(!is_verified(&path, &source).unwrap());

        fs::write(&path, b"hello dump").unwrap();
        assert!(is_verified(&path, &source).unwrap());

        fs::write(&path, b"hello dumq").unwrap(); // same length, different bytes
        assert!(!is_verified(&path, &source).unwrap());

        fs::write(&path, b"hello").unwrap();
        assert!(!is_verified(&path, &source).unwrap());
    }

    #[test]
    fn complete_partial_needs_no_request() {
        // The URL is unreachable, so success proves no request was made.
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join("t.sql.gz.part");
        let source = source_for(b"already here");
        fs::write(&partial, b"already here").unwrap();
        fetch_remaining(&agent(), &source, &partial).unwrap();
    }

    #[test]
    fn partial_path_appends_suffix() {
        assert_eq!(
            partial_path(Path::new("/x/enwiki-page.sql.gz")),
            Path::new("/x/enwiki-page.sql.gz.part")
        );
    }
}
