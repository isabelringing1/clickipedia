//! Builds browser-readable Wikipedia hyperlink graph shards for Clickipedia.
//!
//! See `README.md` in this directory for the pipeline, formats, and the
//! refresh procedure.

pub mod build;
pub mod connectivity;
pub mod download;
pub mod extsort;
pub mod fixture;
pub mod format;
pub mod manifest;
pub mod pages;
pub mod resolve;
pub mod snapshot;
pub mod sql;
pub mod titles;
pub mod util;
pub mod verify;
