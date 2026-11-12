//! Small shared helpers: hashing, atomic writes, progress logging.

use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use sha1::Sha1;
use sha2::{Digest, Sha256};

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&sha256(bytes))
}

/// Streams a file through SHA-1 and returns `(byte length, lowercase hex digest)`.
pub fn sha1_file(path: &Path) -> Result<(u64, String)> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut hasher = Sha1::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = reader
            .read(&mut buf)
            .with_context(|| format!("reading {}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((total, hex(&hasher.finalize())))
}

/// Writes `bytes` to a sibling temporary file and renames it into place, so a
/// crash never leaves a half-written file under the final name.
pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    let mut tmp_name = path
        .file_name()
        .context("path has no file name")?
        .to_os_string();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    {
        let mut file =
            File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("writing {}", tmp.display()))?;
    }
    fs::rename(&tmp, path)
        .with_context(|| format!("renaming {} to {}", tmp.display(), path.display()))?;
    Ok(())
}

pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{value:.2} {}", UNITS[unit])
    }
}

pub fn human_count(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Periodic progress logging to stderr for long-running passes.
pub struct Progress {
    label: String,
    started: Instant,
    last: Instant,
    interval: Duration,
}

impl Progress {
    pub fn new(label: impl Into<String>) -> Self {
        let now = Instant::now();
        Progress {
            label: label.into(),
            started: now,
            last: now,
            interval: Duration::from_secs(10),
        }
    }

    /// Cheap to call in hot loops when guarded by a row-count mask.
    pub fn tick(&mut self, describe: impl FnOnce() -> String) {
        let now = Instant::now();
        if now.duration_since(self.last) >= self.interval {
            self.last = now;
            eprintln!(
                "  [{}] {} ({:.0}s)",
                self.label,
                describe(),
                now.duration_since(self.started).as_secs_f64()
            );
        }
    }

    pub fn done(&self, summary: impl AsRef<str>) {
        eprintln!(
            "  [{}] {} in {:.1}s",
            self.label,
            summary.as_ref(),
            self.started.elapsed().as_secs_f64()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_encodes_lowercase() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
    }

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn human_count_groups_thousands() {
        assert_eq!(human_count(0), "0");
        assert_eq!(human_count(999), "999");
        assert_eq!(human_count(1000), "1,000");
        assert_eq!(human_count(7068811), "7,068,811");
    }
}
