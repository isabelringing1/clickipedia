//! Whole-graph connectivity analysis: indegree, reachability from the start
//! article, and strongly connected components.
//!
//! The analysis is a pure function of the graph, so `verify` re-runs it and
//! compares the result with the published report byte for byte.

use serde::{Deserialize, Serialize};

pub const REPORT_CONNECTIVITY: &str = "connectivity";
pub const REPORT_ZERO_INDEGREE: &str = "zeroIndegree";
pub const REPORT_ISOLATED: &str = "isolated";
pub const REPORT_UNREACHABLE: &str = "unreachableFromStart";

pub const PATH_CONNECTIVITY: &str = "reports/connectivity.json";
pub const PATH_ZERO_INDEGREE: &str = "reports/zero-indegree.bin";
pub const PATH_ISOLATED: &str = "reports/isolated.bin";
pub const PATH_UNREACHABLE: &str = "reports/unreachable-from-start.bin";

/// How many example articles each list embeds in the JSON report.
pub const SAMPLE_SIZE: usize = 50;
/// How many of the largest component sizes the report lists.
pub const TOP_COMPONENTS: usize = 10;

/// Compressed sparse row adjacency for the whole graph.
pub struct Csr {
    /// `n + 1` offsets into `targets`.
    pub offsets: Vec<u64>,
    pub targets: Vec<u32>,
}

impl Csr {
    pub fn node_count(&self) -> usize {
        self.offsets.len() - 1
    }

    pub fn edge_count(&self) -> u64 {
        self.targets.len() as u64
    }

    pub fn neighbors(&self, node: u32) -> &[u32] {
        &self.targets[self.offsets[node as usize] as usize..self.offsets[node as usize + 1] as usize]
    }

    pub fn out_degree(&self, node: u32) -> u64 {
        self.offsets[node as usize + 1] - self.offsets[node as usize]
    }
}

/// Incrementally builds a [`Csr`] from edges arriving in `(source, target)` order.
pub struct CsrBuilder {
    node_count: u32,
    offsets: Vec<u64>,
    targets: Vec<u32>,
}

impl CsrBuilder {
    pub fn new(node_count: u32) -> Self {
        let mut offsets = Vec::with_capacity(node_count as usize + 1);
        offsets.push(0);
        CsrBuilder {
            node_count,
            offsets,
            targets: Vec::new(),
        }
    }

    /// Sources must not decrease between calls.
    pub fn push(&mut self, source: u32, target: u32) {
        debug_assert!(source < self.node_count && target < self.node_count);
        debug_assert!(source as usize + 1 >= self.offsets.len());
        while self.offsets.len() <= source as usize {
            self.offsets.push(self.targets.len() as u64);
        }
        self.targets.push(target);
    }

    pub fn finish(mut self) -> Csr {
        while self.offsets.len() <= self.node_count as usize {
            self.offsets.push(self.targets.len() as u64);
        }
        self.targets.shrink_to_fit();
        Csr {
            offsets: self.offsets,
            targets: self.targets,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SizeBucket {
    pub min_size: u32,
    /// Inclusive; `None` means unbounded.
    pub max_size: Option<u32>,
    pub components: u32,
    pub articles: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Analysis {
    pub zero_indegree: Vec<u32>,
    /// No links in and no links out.
    pub isolated: Vec<u32>,
    /// Articles reachable from the start article, including the start itself.
    pub reachable_from_start: u32,
    pub unreachable_from_start: Vec<u32>,
    pub component_count: u32,
    pub largest_component: u32,
    pub start_component: u32,
    pub start_in_largest_component: bool,
    pub size_buckets: Vec<SizeBucket>,
    /// Sizes of the largest components, descending.
    pub top_component_sizes: Vec<u32>,
    pub max_out_degree: (u32, u64),
    pub max_in_degree: (u32, u64),
}

const SIZE_BUCKET_BOUNDS: [(u32, Option<u32>); 6] = [
    (1, Some(1)),
    (2, Some(10)),
    (11, Some(100)),
    (101, Some(1_000)),
    (1_001, Some(100_000)),
    (100_001, None),
];

pub fn analyze(graph: &Csr, start: u32) -> Analysis {
    let n = graph.node_count();
    assert!((start as usize) < n, "start ordinal is out of range");

    let mut indegree = vec![0u32; n];
    for &target in &graph.targets {
        indegree[target as usize] += 1;
    }

    let mut zero_indegree = Vec::new();
    let mut isolated = Vec::new();
    let mut max_out_degree = (0u32, 0u64);
    let mut max_in_degree = (0u32, 0u64);
    for node in 0..n as u32 {
        let out = graph.out_degree(node);
        let inn = indegree[node as usize] as u64;
        if inn == 0 {
            zero_indegree.push(node);
            if out == 0 {
                isolated.push(node);
            }
        }
        // Strict comparison keeps the lowest ordinal on ties.
        if out > max_out_degree.1 {
            max_out_degree = (node, out);
        }
        if inn > max_in_degree.1 {
            max_in_degree = (node, inn);
        }
    }
    drop(indegree);

    // Breadth-first reachability from the start article.
    let mut seen = vec![false; n];
    let mut queue = vec![start];
    seen[start as usize] = true;
    let mut head = 0;
    while head < queue.len() {
        let node = queue[head];
        head += 1;
        for &next in graph.neighbors(node) {
            if !seen[next as usize] {
                seen[next as usize] = true;
                queue.push(next);
            }
        }
    }
    let reachable_from_start = queue.len() as u32;
    drop(queue);
    let unreachable_from_start: Vec<u32> = (0..n as u32).filter(|&v| !seen[v as usize]).collect();
    drop(seen);

    let (component_of, sizes) = strongly_connected_components(graph);
    let component_count = sizes.len() as u32;
    let largest_component = sizes.iter().copied().max().unwrap_or(0);
    let start_component = sizes[component_of[start as usize] as usize];

    let mut size_buckets: Vec<SizeBucket> = SIZE_BUCKET_BOUNDS
        .iter()
        .map(|&(min_size, max_size)| SizeBucket {
            min_size,
            max_size,
            components: 0,
            articles: 0,
        })
        .collect();
    for &size in &sizes {
        let bucket = size_buckets
            .iter_mut()
            .find(|b| size >= b.min_size && b.max_size.is_none_or(|max| size <= max))
            .expect("size buckets cover every positive size");
        bucket.components += 1;
        bucket.articles += size as u64;
    }

    let mut top_component_sizes = sizes;
    top_component_sizes.sort_unstable_by(|a, b| b.cmp(a));
    top_component_sizes.truncate(TOP_COMPONENTS);

    Analysis {
        zero_indegree,
        isolated,
        reachable_from_start,
        unreachable_from_start,
        component_count,
        largest_component,
        start_component,
        start_in_largest_component: start_component == largest_component,
        size_buckets,
        top_component_sizes,
        max_out_degree,
        max_in_degree,
    }
}

/// Iterative Tarjan. Returns each node's component ID and the component sizes.
///
/// Recursion is replaced by an explicit stack because real link graphs contain
/// paths millions of nodes deep.
fn strongly_connected_components(graph: &Csr) -> (Vec<u32>, Vec<u32>) {
    const UNSEEN: u32 = u32::MAX;
    let n = graph.node_count();
    let mut index = vec![UNSEEN; n];
    let mut low = vec![0u32; n];
    // A node is on the Tarjan stack while it is indexed but has no component.
    let mut component = vec![UNSEEN; n];
    let mut stack: Vec<u32> = Vec::new();
    // (node, position of its next unexplored edge in `targets`)
    let mut calls: Vec<(u32, u64)> = Vec::new();
    let mut sizes: Vec<u32> = Vec::new();
    let mut next_index = 0u32;

    for root in 0..n as u32 {
        if index[root as usize] != UNSEEN {
            continue;
        }
        index[root as usize] = next_index;
        low[root as usize] = next_index;
        next_index += 1;
        stack.push(root);
        calls.push((root, graph.offsets[root as usize]));

        while let Some(&(node, position)) = calls.last() {
            let v = node as usize;
            if position < graph.offsets[v + 1] {
                calls.last_mut().unwrap().1 = position + 1;
                let next = graph.targets[position as usize];
                let w = next as usize;
                if index[w] == UNSEEN {
                    index[w] = next_index;
                    low[w] = next_index;
                    next_index += 1;
                    stack.push(next);
                    calls.push((next, graph.offsets[w]));
                } else if component[w] == UNSEEN {
                    low[v] = low[v].min(index[w]);
                }
                continue;
            }

            calls.pop();
            if let Some(&(parent, _)) = calls.last() {
                let p = parent as usize;
                low[p] = low[p].min(low[v]);
            }
            if low[v] == index[v] {
                let id = sizes.len() as u32;
                let mut size = 0u32;
                loop {
                    let member = stack.pop().expect("Tarjan stack underflow");
                    component[member as usize] = id;
                    size += 1;
                    if member == node {
                        break;
                    }
                }
                sizes.push(size);
            }
        }
    }
    (component, sizes)
}

// ---- JSON report ---------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArticleRef {
    pub ordinal: u32,
    pub title: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArticleList {
    pub count: u32,
    /// Snapshot-relative path of the complete list: little-endian `u32`
    /// ordinals in ascending order, with no header.
    pub list: String,
    /// The first few entries, for a human skimming the report.
    pub sample: Vec<ArticleRef>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartReport {
    pub ordinal: u32,
    pub title: String,
    /// Includes the start article itself.
    pub reachable: u32,
    pub unreachable: u32,
    pub component_size: u32,
    pub in_largest_component: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SizeBucketReport {
    pub min_size: u32,
    pub max_size: Option<u32>,
    pub components: u32,
    pub articles: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComponentsReport {
    pub count: u32,
    pub largest: u32,
    pub size_histogram: Vec<SizeBucketReport>,
    pub top_sizes: Vec<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DegreeRef {
    pub ordinal: u32,
    pub title: String,
    pub degree: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DegreesReport {
    pub max_out: DegreeRef,
    pub max_in: DegreeRef,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityReport {
    pub schema_version: u32,
    pub snapshot_id: String,
    pub articles: u32,
    pub edges: u64,
    pub start: StartReport,
    pub zero_indegree: ArticleList,
    pub isolated: ArticleList,
    pub unreachable_from_start: ArticleList,
    pub strongly_connected_components: ComponentsReport,
    pub degrees: DegreesReport,
}

/// Assembles the JSON report. `title_of` maps an ordinal to its display title.
pub fn build_report(
    snapshot_id: &str,
    graph: &Csr,
    start: u32,
    analysis: &Analysis,
    title_of: &dyn Fn(u32) -> String,
) -> ConnectivityReport {
    let list = |ordinals: &[u32], path: &str| ArticleList {
        count: ordinals.len() as u32,
        list: path.to_string(),
        sample: ordinals
            .iter()
            .take(SAMPLE_SIZE)
            .map(|&ordinal| ArticleRef {
                ordinal,
                title: title_of(ordinal),
            })
            .collect(),
    };
    let degree = |(ordinal, degree): (u32, u64)| DegreeRef {
        ordinal,
        title: title_of(ordinal),
        degree,
    };
    ConnectivityReport {
        schema_version: crate::manifest::SCHEMA_VERSION,
        snapshot_id: snapshot_id.to_string(),
        articles: graph.node_count() as u32,
        edges: graph.edge_count(),
        start: StartReport {
            ordinal: start,
            title: title_of(start),
            reachable: analysis.reachable_from_start,
            unreachable: analysis.unreachable_from_start.len() as u32,
            component_size: analysis.start_component,
            in_largest_component: analysis.start_in_largest_component,
        },
        zero_indegree: list(&analysis.zero_indegree, PATH_ZERO_INDEGREE),
        isolated: list(&analysis.isolated, PATH_ISOLATED),
        unreachable_from_start: list(&analysis.unreachable_from_start, PATH_UNREACHABLE),
        strongly_connected_components: ComponentsReport {
            count: analysis.component_count,
            largest: analysis.largest_component,
            size_histogram: analysis
                .size_buckets
                .iter()
                .map(|bucket| SizeBucketReport {
                    min_size: bucket.min_size,
                    max_size: bucket.max_size,
                    components: bucket.components,
                    articles: bucket.articles,
                })
                .collect(),
            top_sizes: analysis.top_component_sizes.clone(),
        },
        degrees: DegreesReport {
            max_out: degree(analysis.max_out_degree),
            max_in: degree(analysis.max_in_degree),
        },
    }
}

/// Encodes an ordinal list as headerless little-endian `u32` values.
pub fn encode_ordinal_list(ordinals: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(ordinals.len() * 4);
    for &ordinal in ordinals {
        out.extend_from_slice(&ordinal.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph(node_count: u32, edges: &[(u32, u32)]) -> Csr {
        let mut sorted = edges.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        let mut builder = CsrBuilder::new(node_count);
        for (source, target) in sorted {
            builder.push(source, target);
        }
        builder.finish()
    }

    #[test]
    fn csr_builder_handles_gaps_and_trailing_nodes() {
        let csr = graph(5, &[(1, 0), (1, 3), (3, 4)]);
        assert_eq!(csr.node_count(), 5);
        assert_eq!(csr.edge_count(), 3);
        assert!(csr.neighbors(0).is_empty());
        assert_eq!(csr.neighbors(1), &[0, 3]);
        assert!(csr.neighbors(2).is_empty());
        assert_eq!(csr.neighbors(3), &[4]);
        assert!(csr.neighbors(4).is_empty());
        assert_eq!(csr.out_degree(1), 2);
    }

    #[test]
    fn analyzes_small_graph() {
        // 0 <-> 1, 0 <-> 2 form one component; 1 -> 3 -> 4 -> 7 trails off;
        // 5 has only out-links; 6 is isolated; 8 <-> 9 is a separate island.
        let csr = graph(
            10,
            &[
                (0, 1),
                (0, 2),
                (0, 4),
                (1, 0),
                (1, 3),
                (1, 7),
                (2, 0),
                (3, 4),
                (4, 7),
                (5, 1),
                (8, 9),
                (9, 8),
            ],
        );
        let analysis = analyze(&csr, 0);
        assert_eq!(analysis.zero_indegree, vec![5, 6]);
        assert_eq!(analysis.isolated, vec![6]);
        assert_eq!(analysis.reachable_from_start, 6);
        assert_eq!(analysis.unreachable_from_start, vec![5, 6, 8, 9]);
        assert_eq!(analysis.component_count, 7);
        assert_eq!(analysis.largest_component, 3);
        assert_eq!(analysis.start_component, 3);
        assert!(analysis.start_in_largest_component);
        assert_eq!(analysis.top_component_sizes, vec![3, 2, 1, 1, 1, 1, 1]);
        assert_eq!(analysis.size_buckets[0].components, 5);
        assert_eq!(analysis.size_buckets[0].articles, 5);
        assert_eq!(analysis.size_buckets[1].components, 2);
        assert_eq!(analysis.size_buckets[1].articles, 5);
        assert_eq!(analysis.max_out_degree, (0, 3));
        // 0, 1, 4 and 7 all have indegree 2; the lowest ordinal wins.
        assert_eq!(analysis.max_in_degree, (0, 2));
    }

    #[test]
    fn start_outside_largest_component() {
        let csr = graph(5, &[(0, 1), (1, 2), (2, 3), (3, 1)]);
        let analysis = analyze(&csr, 0);
        assert_eq!(analysis.largest_component, 3);
        assert_eq!(analysis.start_component, 1);
        assert!(!analysis.start_in_largest_component);
        assert_eq!(analysis.reachable_from_start, 4);
        assert_eq!(analysis.unreachable_from_start, vec![4]);
        assert_eq!(analysis.zero_indegree, vec![0, 4]);
        assert_eq!(analysis.isolated, vec![4]);
    }

    #[test]
    fn deep_chain_and_big_cycle_do_not_overflow_the_stack() {
        let n = 300_000u32;
        let chain: Vec<(u32, u32)> = (0..n - 1).map(|i| (i, i + 1)).collect();
        let analysis = analyze(&graph(n, &chain), 0);
        assert_eq!(analysis.component_count, n);
        assert_eq!(analysis.largest_component, 1);
        assert_eq!(analysis.reachable_from_start, n);

        let mut cycle = chain;
        cycle.push((n - 1, 0));
        let analysis = analyze(&graph(n, &cycle), 7);
        assert_eq!(analysis.component_count, 1);
        assert_eq!(analysis.largest_component, n);
        assert!(analysis.zero_indegree.is_empty());
    }

    #[test]
    fn component_sizes_match_brute_force_on_pseudorandom_graphs() {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for round in 0..20 {
            let n = 30 + round;
            let edge_count = 20 + (next() % 60) as usize;
            let edges: Vec<(u32, u32)> = (0..edge_count)
                .map(|_| ((next() % n as u64) as u32, (next() % n as u64) as u32))
                .filter(|(a, b)| a != b)
                .collect();
            let csr = graph(n, &edges);

            // Brute force: transitive closure, then mutual reachability.
            let size = n as usize;
            let mut reach = vec![vec![false; size]; size];
            for v in 0..size {
                reach[v][v] = true;
                for &w in csr.neighbors(v as u32) {
                    reach[v][w as usize] = true;
                }
            }
            for k in 0..size {
                for i in 0..size {
                    if reach[i][k] {
                        for j in 0..size {
                            if reach[k][j] {
                                reach[i][j] = true;
                            }
                        }
                    }
                }
            }
            let mut assigned = vec![false; size];
            let mut expected_sizes = Vec::new();
            for v in 0..size {
                if assigned[v] {
                    continue;
                }
                let members: Vec<usize> =
                    (0..size).filter(|&w| reach[v][w] && reach[w][v]).collect();
                for &m in &members {
                    assigned[m] = true;
                }
                expected_sizes.push(members.len() as u32);
            }
            expected_sizes.sort_unstable_by(|a, b| b.cmp(a));

            let analysis = analyze(&csr, 0);
            assert_eq!(analysis.component_count as usize, expected_sizes.len());
            expected_sizes.truncate(TOP_COMPONENTS);
            assert_eq!(analysis.top_component_sizes, expected_sizes);
            assert_eq!(
                analysis.reachable_from_start as usize,
                reach[0].iter().filter(|&&r| r).count()
            );
        }
    }

    #[test]
    fn ordinal_lists_are_little_endian() {
        assert_eq!(
            encode_ordinal_list(&[1, 0x0102_0304]),
            vec![1, 0, 0, 0, 4, 3, 2, 1]
        );
    }
}
