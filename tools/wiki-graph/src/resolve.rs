//! The `resolve` command: pins an exact, completed Wikimedia dump.
//!
//! The mutable `latest/` path is never used. `resolve` reads the dated run's
//! `dumpstatus.json` and writes a source lock holding exact URLs, sizes, and
//! checksums, which every later step is checked against.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use serde::Deserialize;

use crate::manifest::{is_dump_date, SourceFile, SourceLock, SCHEMA_VERSION, TABLES};

pub const DEFAULT_BASE_URL: &str = "https://dumps.wikimedia.org";
pub const DEFAULT_WIKI: &str = "enwiki";
pub const USER_AGENT: &str = concat!(
    "Clickipedia-wiki-graph/",
    env!("CARGO_PKG_VERSION"),
    " (https://isabisabel.com/clickipedia/; graph builder)"
);

/// Dump job that produces each table.
fn job_for(table: &str) -> &'static str {
    match table {
        "page" => "pagetable",
        "redirect" => "redirecttable",
        "linktarget" => "linktargettable",
        "pagelinks" => "pagelinkstable",
        other => panic!("no dump job is known for table {other}"),
    }
}

#[derive(Deserialize, Debug, Clone)]
pub struct DumpStatus {
    pub jobs: BTreeMap<String, Job>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Job {
    pub status: String,
    #[serde(default)]
    pub files: BTreeMap<String, JobFile>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct JobFile {
    pub size: Option<u64>,
    pub url: Option<String>,
    pub sha1: Option<String>,
    pub md5: Option<String>,
}

impl DumpStatus {
    /// True when every job of the run has finished.
    pub fn is_complete(&self) -> bool {
        !self.jobs.is_empty() && self.jobs.values().all(|job| job.status == "done")
    }

    pub fn unfinished_jobs(&self) -> Vec<&str> {
        self.jobs
            .iter()
            .filter(|(_, job)| job.status != "done")
            .map(|(name, _)| name.as_str())
            .collect()
    }
}

pub fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .user_agent(USER_AGENT)
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(120))
        .build()
}

/// Extracts `YYYYMMDD/` directory names from a dump index page, ascending.
pub fn parse_dump_dates(html: &str) -> Vec<String> {
    let mut dates: Vec<String> = html
        .split("href=\"")
        .skip(1)
        .filter_map(|rest| {
            let candidate = rest.get(..8)?;
            (is_dump_date(candidate) && rest[8..].starts_with("/\"")).then(|| candidate.to_string())
        })
        .collect();
    dates.sort();
    dates.dedup();
    dates
}

/// Builds the lock for one run from its status document.
pub fn lock_from_status(
    status: &DumpStatus,
    base_url: &str,
    wiki: &str,
    date: &str,
) -> Result<SourceLock> {
    let base_url = base_url.trim_end_matches('/');
    let mut files = BTreeMap::new();
    for table in TABLES {
        let job_name = job_for(table);
        let job = status
            .jobs
            .get(job_name)
            .with_context(|| format!("dump {wiki} {date} has no `{job_name}` job"))?;
        ensure!(
            job.status == "done",
            "dump {wiki} {date}: job `{job_name}` is `{}`, not `done`",
            job.status
        );
        ensure!(
            job.files.len() == 1,
            "dump {wiki} {date}: job `{job_name}` lists {} files, expected exactly one",
            job.files.len()
        );
        let (name, file) = job.files.iter().next().unwrap();
        let expected_prefix = format!("{wiki}-{date}-{table}.sql");
        ensure!(
            name.starts_with(&expected_prefix) && !name.contains('/'),
            "dump {wiki} {date}: unexpected file name {name:?} for table `{table}`"
        );
        let path = file
            .url
            .as_deref()
            .with_context(|| format!("{name}: status has no URL"))?;
        ensure!(
            path.starts_with('/') && !path.contains(".."),
            "{name}: unexpected URL path {path:?}"
        );
        let sha1 = file
            .sha1
            .as_deref()
            .with_context(|| format!("{name}: status has no SHA-1 checksum"))?;
        files.insert(
            table.to_string(),
            SourceFile {
                file: name.clone(),
                url: format!("{base_url}{path}"),
                bytes: file.size.with_context(|| format!("{name}: status has no size"))?,
                sha1: sha1.to_ascii_lowercase(),
                md5: file.md5.as_ref().map(|md5| md5.to_ascii_lowercase()),
            },
        );
    }
    let lock = SourceLock {
        schema_version: SCHEMA_VERSION,
        wiki: wiki.to_string(),
        dump_date: date.to_string(),
        files,
    };
    lock.validate()?;
    Ok(lock)
}

fn fetch_text(agent: &ureq::Agent, url: &str) -> Result<Option<String>> {
    match agent.get(url).call() {
        Ok(response) => Ok(Some(
            response
                .into_string()
                .with_context(|| format!("reading {url}"))?,
        )),
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(error) => Err(error).with_context(|| format!("fetching {url}")),
    }
}

fn fetch_status(agent: &ureq::Agent, base_url: &str, wiki: &str, date: &str) -> Result<Option<DumpStatus>> {
    let url = format!("{}/{wiki}/{date}/dumpstatus.json", base_url.trim_end_matches('/'));
    let Some(text) = fetch_text(agent, &url)? else {
        return Ok(None);
    };
    let status = serde_json::from_str(&text).with_context(|| format!("parsing {url}"))?;
    Ok(Some(status))
}

pub enum Selection {
    /// Reproduce a specific run.
    Date(String),
    /// Deliberately move to the newest run whose every job has finished.
    NewestComplete,
}

pub fn resolve(base_url: &str, wiki: &str, selection: &Selection) -> Result<SourceLock> {
    let agent = agent();
    match selection {
        Selection::Date(date) => {
            ensure!(is_dump_date(date), "--date must be YYYYMMDD, got {date:?}");
            let status = fetch_status(&agent, base_url, wiki, date)?
                .with_context(|| format!("no dump run {wiki} {date} exists"))?;
            if !status.is_complete() {
                bail!(
                    "dump {wiki} {date} is not complete; unfinished jobs: {}",
                    status.unfinished_jobs().join(", ")
                );
            }
            lock_from_status(&status, base_url, wiki, date)
        }
        Selection::NewestComplete => {
            let index_url = format!("{}/{wiki}/", base_url.trim_end_matches('/'));
            let html = fetch_text(&agent, &index_url)?
                .with_context(|| format!("{index_url} does not exist"))?;
            let dates = parse_dump_dates(&html);
            ensure!(!dates.is_empty(), "no dated dump runs listed at {index_url}");
            for date in dates.iter().rev() {
                match fetch_status(&agent, base_url, wiki, date)? {
                    None => eprintln!("  {date}: no status document, skipping"),
                    Some(status) if !status.is_complete() => eprintln!(
                        "  {date}: still running ({} unfinished jobs), skipping",
                        status.unfinished_jobs().len()
                    ),
                    Some(status) => {
                        eprintln!("  {date}: complete");
                        return lock_from_status(&status, base_url, wiki, date);
                    }
                }
            }
            bail!("none of the {} listed dump runs is complete", dates.len())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INDEX: &str = r#"<html><body><pre><a href="../">../</a>
<a href="20260901/">20260901/</a>   15-Sep-2026 04:50   -
<a href="20261101/">20261101/</a>   10-Nov-2026 00:31   -
<a href="20261001/">20261001/</a>   14-Oct-2026 22:15   -
<a href="latest/">latest/</a>       08-Nov-2026 00:56   -
<a href="2026100/">bad</a> <a href="20261001x/">bad</a>
</pre></body></html>"#;

    fn status(json_jobs: &str) -> DumpStatus {
        serde_json::from_str(&format!("{{\"version\":\"0.8\",\"jobs\":{{{json_jobs}}}}}")).unwrap()
    }

    fn table_job(job: &str, table: &str, state: &str) -> String {
        format!(
            r#""{job}":{{"status":"{state}","updated":"2026-10-08 03:27:23","files":{{"enwiki-20261001-{table}.sql.gz":{{"size":123,"url":"/enwiki/20261001/enwiki-20261001-{table}.sql.gz","md5":"C0B4CFD8479B0B8BE33C41155CEED64D","sha1":"08C19861E908C6F324AD091687EA19BFF8D62BB4"}}}}}}"#
        )
    }

    fn all_tables(state: &str) -> String {
        [
            table_job("pagetable", "page", state),
            table_job("redirecttable", "redirect", state),
            table_job("linktargettable", "linktarget", state),
            table_job("pagelinkstable", "pagelinks", state),
        ]
        .join(",")
    }

    #[test]
    fn parses_dated_directories_only() {
        assert_eq!(parse_dump_dates(INDEX), ["20260901", "20261001", "20261101"]);
        assert!(parse_dump_dates("<html></html>").is_empty());
    }

    #[test]
    fn completeness_requires_every_job() {
        let done = status(&all_tables("done"));
        assert!(done.is_complete());

        let running = status(&format!(
            "{},\"metahistory7zdump\":{{\"status\":\"in-progress\"}}",
            all_tables("done")
        ));
        assert!(!running.is_complete());
        assert_eq!(running.unfinished_jobs(), ["metahistory7zdump"]);

        assert!(!status("").is_complete());
    }

    #[test]
    fn builds_lock_with_absolute_urls_and_lowercase_checksums() {
        let lock = lock_from_status(
            &status(&all_tables("done")),
            "https://dumps.wikimedia.org/",
            "enwiki",
            "20261001",
        )
        .unwrap();
        assert_eq!(lock.dump_date, "20261001");
        let page = lock.file("page");
        assert_eq!(page.file, "enwiki-20261001-page.sql.gz");
        assert_eq!(
            page.url,
            "https://dumps.wikimedia.org/enwiki/20261001/enwiki-20261001-page.sql.gz"
        );
        assert_eq!(page.bytes, 123);
        assert_eq!(page.sha1, "08c19861e908c6f324ad091687ea19bff8d62bb4");
        assert_eq!(page.md5.as_deref(), Some("c0b4cfd8479b0b8be33c41155ceed64d"));
        assert_eq!(lock.files.len(), 4);
    }

    #[test]
    fn rejects_unfinished_or_malformed_table_jobs() {
        let unfinished = status(&[
            table_job("pagetable", "page", "done"),
            table_job("redirecttable", "redirect", "done"),
            table_job("linktargettable", "linktarget", "done"),
            table_job("pagelinkstable", "pagelinks", "in-progress"),
        ]
        .join(","));
        assert!(lock_from_status(&unfinished, DEFAULT_BASE_URL, "enwiki", "20261001").is_err());

        let missing = status(&table_job("pagetable", "page", "done"));
        assert!(lock_from_status(&missing, DEFAULT_BASE_URL, "enwiki", "20261001").is_err());

        // A file name that does not match the requested run is refused.
        let wrong_date = status(&all_tables("done"));
        assert!(lock_from_status(&wrong_date, DEFAULT_BASE_URL, "enwiki", "20260901").is_err());
    }
}
