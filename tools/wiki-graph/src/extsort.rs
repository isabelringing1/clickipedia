//! Bounded-memory external sort for `(source, target)` edges.
//!
//! Edges are packed into `u64` keys (`source << 32 | target`), buffered up to a
//! fixed capacity, sorted, deduplicated, and spilled to run files. The runs are
//! then merged with a k-way heap, dropping duplicates that span runs, so the
//! caller sees every unique edge exactly once in `(source, target)` order.

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};

const RUN_IO_BUFFER_BYTES: usize = 1 << 20;

#[inline]
pub fn pack(source: u32, target: u32) -> u64 {
    ((source as u64) << 32) | target as u64
}

#[inline]
pub fn unpack(key: u64) -> (u32, u32) {
    ((key >> 32) as u32, key as u32)
}

pub struct EdgeSorter {
    dir: PathBuf,
    buffer: Vec<u64>,
    capacity: usize,
    runs: Vec<PathBuf>,
    pushed: u64,
}

impl EdgeSorter {
    /// `capacity` is the number of edges held in memory (8 bytes each).
    pub fn new(dir: &Path, capacity: usize) -> Result<Self> {
        ensure!(capacity > 0, "sort capacity must be at least one edge");
        fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        Ok(EdgeSorter {
            dir: dir.to_path_buf(),
            buffer: Vec::with_capacity(capacity),
            capacity,
            runs: Vec::new(),
            pushed: 0,
        })
    }

    #[inline]
    pub fn push(&mut self, source: u32, target: u32) -> Result<()> {
        self.buffer.push(pack(source, target));
        self.pushed += 1;
        if self.buffer.len() >= self.capacity {
            self.spill()?;
        }
        Ok(())
    }

    /// Edges pushed so far, before deduplication.
    pub fn pushed(&self) -> u64 {
        self.pushed
    }

    pub fn run_count(&self) -> usize {
        self.runs.len()
    }

    fn spill(&mut self) -> Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        self.buffer.sort_unstable();
        self.buffer.dedup();
        let path = self.dir.join(format!("run-{:05}.bin", self.runs.len()));
        let file = File::create(&path).with_context(|| format!("creating {}", path.display()))?;
        let mut writer = BufWriter::with_capacity(RUN_IO_BUFFER_BYTES, file);
        for &key in &self.buffer {
            writer.write_all(&key.to_le_bytes())?;
        }
        writer
            .flush()
            .with_context(|| format!("writing {}", path.display()))?;
        self.runs.push(path);
        self.buffer.clear();
        Ok(())
    }

    /// Flushes the remaining buffer and starts the merge.
    pub fn finish(mut self) -> Result<MergedEdges> {
        self.spill()?;
        // Release the sort buffer before the merge allocates its own state.
        self.buffer = Vec::new();
        let mut readers = Vec::with_capacity(self.runs.len());
        let mut heap = BinaryHeap::with_capacity(self.runs.len());
        for (index, path) in self.runs.iter().enumerate() {
            let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
            let mut reader = BufReader::with_capacity(RUN_IO_BUFFER_BYTES, file);
            if let Some(key) = read_key(&mut reader)? {
                heap.push(Reverse((key, index)));
            }
            readers.push(reader);
        }
        Ok(MergedEdges {
            readers,
            heap,
            last: None,
            paths: std::mem::take(&mut self.runs),
        })
    }
}

fn read_key(reader: &mut BufReader<File>) -> Result<Option<u64>> {
    let mut bytes = [0u8; 8];
    let mut filled = 0;
    while filled < bytes.len() {
        let n = reader.read(&mut bytes[filled..]).context("reading sort run")?;
        if n == 0 {
            ensure!(filled == 0, "sort run ends in the middle of an edge");
            return Ok(None);
        }
        filled += n;
    }
    Ok(Some(u64::from_le_bytes(bytes)))
}

/// Streaming merge of the sorted runs. Deletes the run files when dropped.
pub struct MergedEdges {
    readers: Vec<BufReader<File>>,
    heap: BinaryHeap<Reverse<(u64, usize)>>,
    last: Option<u64>,
    paths: Vec<PathBuf>,
}

impl MergedEdges {
    /// Next unique edge in ascending `(source, target)` order.
    pub fn next_edge(&mut self) -> Result<Option<(u32, u32)>> {
        while let Some(Reverse((key, index))) = self.heap.pop() {
            if let Some(next) = read_key(&mut self.readers[index])? {
                self.heap.push(Reverse((next, index)));
            }
            if self.last == Some(key) {
                continue;
            }
            self.last = Some(key);
            return Ok(Some(unpack(key)));
        }
        Ok(None)
    }
}

impl Drop for MergedEdges {
    fn drop(&mut self) {
        self.readers.clear();
        for path in &self.paths {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sort_all(edges: &[(u32, u32)], capacity: usize) -> (Vec<(u32, u32)>, usize) {
        let dir = tempfile::tempdir().unwrap();
        let mut sorter = EdgeSorter::new(dir.path(), capacity).unwrap();
        for &(source, target) in edges {
            sorter.push(source, target).unwrap();
        }
        assert_eq!(sorter.pushed(), edges.len() as u64);
        let mut merged = sorter.finish().unwrap();
        let runs = merged.paths.len();
        let mut out = Vec::new();
        while let Some(edge) = merged.next_edge().unwrap() {
            out.push(edge);
        }
        drop(merged);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0, "runs are cleaned up");
        (out, runs)
    }

    #[test]
    fn packs_source_in_high_bits() {
        assert_eq!(unpack(pack(u32::MAX, 0)), (u32::MAX, 0));
        assert_eq!(unpack(pack(0, u32::MAX)), (0, u32::MAX));
        assert!(pack(1, 0) > pack(0, u32::MAX));
    }

    #[test]
    fn sorts_and_deduplicates_within_and_across_runs() {
        let edges = [
            (3, 1),
            (0, 9),
            (3, 1),
            (2, 2),
            (0, 1),
            (3, 0),
            (0, 9),
            (1, 4_000_000_000),
            (0, 1),
            (3, 1),
        ];
        let expected = vec![(0, 1), (0, 9), (1, 4_000_000_000), (2, 2), (3, 0), (3, 1)];
        for capacity in [1, 2, 3, 4, 100] {
            let (sorted, runs) = sort_all(&edges, capacity);
            assert_eq!(sorted, expected, "capacity {capacity}");
            if capacity == 100 {
                assert_eq!(runs, 1);
            } else {
                assert!(runs > 1);
            }
        }
    }

    #[test]
    fn empty_input_yields_nothing() {
        let (sorted, runs) = sort_all(&[], 8);
        assert!(sorted.is_empty());
        assert_eq!(runs, 0);
    }

    #[test]
    fn matches_in_memory_sort_on_pseudorandom_input() {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut edges = Vec::new();
        for _ in 0..20_000 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            edges.push(((state >> 40) as u32 % 500, (state as u32) % 500));
        }
        let mut expected = edges.clone();
        expected.sort_unstable();
        expected.dedup();
        let (sorted, runs) = sort_all(&edges, 777);
        assert_eq!(sorted, expected);
        assert!(runs > 20);
    }
}
