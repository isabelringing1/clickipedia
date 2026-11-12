# wiki-graph

Turns a dated English Wikipedia dump into the link graph Clickipedia plays on:
a directory of small, immutable binary files that a browser can read straight
from Cloudflare R2.

The game never asks Wikipedia which articles link to which. It reads this
graph instead, and only fetches Wikipedia's HTML for articles a player is
actually looking at.

- [Day-to-day development](#day-to-day-development)
- [Commands](#commands)
- [What a snapshot contains](#what-a-snapshot-contains)
- [Time, disk, and memory](#time-disk-and-memory)
- [One-time R2 setup](#one-time-r2-setup)
- [Refreshing the graph](#refreshing-the-graph)
- [Rules for published snapshots](#rules-for-published-snapshots)
- [How the game uses a snapshot](#how-the-game-uses-a-snapshot)
- [Articles that cannot be reached](#articles-that-cannot-be-reached)
- [Tests](#tests)

## Day-to-day development

You need Node 20+ and, to build graphs, a Rust toolchain. Nothing here needs
a Cloudflare account until you publish.

To work on the game without building anything, serve the tiny test graph
(ten articles) that is checked into `fixtures/`:

```sh
npm run graph:serve -- --fixture
```

To play on real data, build a snapshot once (about 11 GiB of downloads, see
[Time, disk, and memory](#time-disk-and-memory)) and serve that:

```sh
npm run graph -- download --source 20261001
npm run graph -- build --source 20261001
npm run graph -- verify --snapshot 20261001
npm run graph -- promote --snapshot 20261001   # writes the local latest.json
npm run graph:serve
```

Either way, tell the game where the graph is by copying `.env.example` to
`.env.development.local` (it already contains `http://localhost:8787/`), then
run `npm run dev`.

The local server answers the way the production bucket is configured to: same
`Cache-Control` and `Content-Type` values, and CORS for the same origins. If
you rebuild a snapshot under the same ID while developing the pipeline, start
it with `--no-store` so the browser does not keep the old files.

## Commands

`npm run graph -- <command>` runs the Rust tool (`cargo run --release`).
Everything it downloads or builds goes under `tools/wiki-graph/data.nosync/`,
which is gitignored; pass `--data-dir` or set `WIKI_GRAPH_DATA_DIR` to put it
elsewhere. (The `.nosync` suffix stops iCloud from uploading it when the
repository lives in a synced folder.)

| Command | What it does |
| --- | --- |
| `resolve --date YYYYMMDD` | Pins one completed dump run: records the four files' URLs, sizes, and SHA-1 checksums in `sources/enwiki-<date>.json`. `--newest-complete` picks the newest finished run instead. |
| `download --source <date>` | Downloads the pinned files, resuming partial downloads, and checks every checksum. |
| `build --source <date>` | Builds `public/snapshots/<date>/` from the downloaded files. |
| `verify --snapshot <id>` | Re-reads a built snapshot: every file's length and SHA-256, every shard's structure, every link target, every title, and the connectivity report recomputed from scratch. `--expect-link FROM TO` requires a known link; `--same-as <dir>` requires another build to be byte-identical; `--quick` skips the checks that load the whole graph. |
| `compare --old <id> --new <id>` | Fails if the new snapshot's totals moved implausibly from the old one's. |
| `promote --snapshot <id>` | Points the *local* `latest.json` at a snapshot, for `graph:serve`. |
| `fixture [--check]` | Regenerates, or checks, the test snapshot in `fixtures/tiny/`. |

The lock files in `sources/` are committed. A lock is what makes a build
reproducible: the tool never reads Wikimedia's mutable `latest` path, and a
download whose checksum differs from the lock is rejected.

The publishing commands are Node scripts in `scripts/`:

| Command | What it does |
| --- | --- |
| `npm run graph:serve` | Serves `data.nosync/public` (or `--fixture`) on `http://localhost:8787/`. |
| `npm run graph:publish` | Uploads a built snapshot to R2. Never touches `latest.json`. |
| `npm run graph:verify-public` | Checks a published snapshot over its public URL, the way a browser reads it. |
| `npm run graph:promote` | Verifies a published snapshot publicly, then points the bucket's `latest.json` at it. |

## What a snapshot contains

```text
latest.json                         which snapshot new games start on (mutable)
snapshots/20261001/
  manifest.json                     counts, layout, source checksums, report list
  adjacency/000000.bin ...          outgoing links, 2,048 source articles per file
  adjacency/index.bin               byte length and SHA-256 of every adjacency file
  metadata/000000.bin ...           page ID and title by article number
  metadata/index.bin
  titles/000000.bin ...             title -> article number, in 4,096 hash buckets
  titles/index.bin
  reports/connectivity.json         reachability and component statistics
  reports/unreachable-from-start.bin, zero-indegree.bin, isolated.bin
```

Articles are the namespace-0 pages that are not redirects. Each gets a dense
number (its *ordinal*, in page-ID order), so "have I opened this article" is
one bit and a list of links is a list of 32-bit integers.

Links come from the `pagelinks` table, which includes links made by templates
such as navigation boxes. A link to a redirect is stored as a link to the
article the redirect leads to; links to missing pages, to other namespaces,
and from an article to itself are dropped, and duplicates are merged.

The title index contains every article title and every redirect that leads to
an article, so the game can turn the text of a link a player clicked into an
ordinal with one small download. Titles are compared after the normalization
in `src/titles.rs`, which `src/wikiGraph/titles.js` in the game mirrors
exactly; both are tested against `fixtures/title-cases.json`.

The binary layouts are documented at the top of `src/format.rs` and decoded
in the browser by `src/wikiGraph/codec.js`. Every integer is a little-endian
`u32`. The manifest does not list every shard: it gives the hash of each
`index.bin`, and each index gives the length and hash of every shard, so the
whole snapshot is pinned by the SHA-256 of `manifest.json`.

A build is deterministic. The same lock and options produce byte-identical
files, which `verify --same-as` checks.

## Time, disk, and memory

Measured for `enwiki` 20261001 on an Apple Silicon laptop:

| | |
| --- | --- |
| Download | 10.5 GiB in four files |
| Scratch space during `build` | about 5.5 GiB of sort runs, deleted afterwards |
| Snapshot | 3.41 GiB in 9,414 files |
| `build` | about 4 minutes, under 3.2 GiB of memory |
| `verify` | about 25 seconds, 3.1 GiB of memory (`--quick`: under 100 MiB) |
| Upload | about 50 minutes (see below) |

Allow 20 GiB of free disk for one snapshot. The downloads can be deleted once
a snapshot is published, but keep `data.nosync/public/snapshots/<id>` for as
long as you may want to promote or roll back to it: promotion compares the
bucket against the local build.

`build` holds every article and redirect title in memory, plus a sort buffer
(`--sort-memory-mb`, 1 GiB by default), plus the whole graph while it
computes the connectivity report.

That snapshot has 7,249,474 articles and 712,837,477 links. Adjacency files
average 0.8 MiB (the largest is 3.8 MiB); title buckets and metadata files
are about 110-150 KiB.

The number of files is a deliberate trade. Uploads go through Cloudflare's
API, which allows about 1,200 requests per five minutes, so `graph:publish`
paces itself at 1,000 objects per five minutes and every extra thousand files
adds five minutes. Smaller shards would mean smaller downloads in the game
but a much longer upload.

## One-time R2 setup

These steps need your Cloudflare account and cannot be scripted from this
repository. Credentials stay on your machine: `wrangler login` stores them in
your user profile, and nothing here reads them. **Never put a Cloudflare or
R2 credential in a `VITE_` variable or a committed file**: every `VITE_`
variable is compiled into the JavaScript sent to players.

1. **Sign in.** `npx wrangler login` (opens a browser). Check with
   `npx wrangler whoami`. R2 must be enabled on the account, which requires a
   payment method even within the free allowance.

2. **Create the bucket.**

   ```sh
   npx wrangler r2 bucket create clickipedia-graph
   ```

3. **Give it a public custom domain.** The domain must be a zone in the same
   Cloudflare account. A custom domain, not the `r2.dev` address, is what
   puts Cloudflare's cache in front of the bucket; `r2.dev` is rate-limited
   and uncached.

   ```sh
   npx wrangler r2 bucket domain add clickipedia-graph \
     --domain graph.example.com --zone-id <zone id> --min-tls 1.2
   ```

   or in the dashboard: R2 > the bucket > Settings > Custom Domains > Add.

4. **Allow the game to read it.** `r2/cors.json` allows `GET` from the game's
   origin and from the Vite dev and preview servers. Edit it if the game
   moves, then apply it:

   ```sh
   npx wrangler r2 bucket cors set clickipedia-graph --file tools/wiki-graph/r2/cors.json
   npx wrangler r2 bucket cors list clickipedia-graph
   ```

   R2 matches origins exactly, including the port, and treats `localhost`
   and `127.0.0.1` as different origins. If you change the policy
   after files have been served, purge the cache for the hostname
   (Caching > Configuration > Purge Everything), or cached responses keep
   the old headers.

5. **Cache every snapshot file.** By default Cloudflare caches `.bin` but not
   `.json`. In the dashboard, under Caching > Cache Rules for the zone, create
   a rule:

   - When: `http.host eq "graph.example.com" and starts_with(http.request.uri.path, "/snapshots/")`
   - Then: Eligible for cache; Edge TTL: use the cache-control header if present.

   Leave `latest.json` out of the rule. Snapshot files are uploaded with
   `Cache-Control: public, max-age=31536000, immutable`; `latest.json` with
   `public, max-age=60, must-revalidate`.

6. **Point the game at it.** Put the public address in
   `.env.production.local` (gitignored) before `npm run build` or
   `npm run deploy`:

   ```sh
   VITE_WIKI_GRAPH_BASE_URL=https://graph.example.com/
   ```

   This is a public URL, not a secret. `npm run build` refuses to make a
   production build without an `https` address here, because the game cannot
   start without the graph.

For the publishing commands below, set the bucket and address once per shell:

```sh
export WIKI_GRAPH_R2_BUCKET=clickipedia-graph
export WIKI_GRAPH_PUBLIC_URL=https://graph.example.com/
```

## Refreshing the graph

Wikimedia starts a new dump on the 1st and 20th of each month; a run takes
several days to finish. The order below matters: nothing becomes visible to
players until the last step, and each step checks the one before it.

1. **Resolve.** Pin the new dump and commit the lock it writes.

   ```sh
   npm run graph -- resolve --newest-complete
   ```

2. **Download.**

   ```sh
   npm run graph -- download --source 20261101
   ```

3. **Build.**

   ```sh
   npm run graph -- build --source 20261101
   ```

4. **Compare** with the snapshot currently in use. This fails if the article
   or link totals moved by more than a few percent, if noticeably fewer
   articles are reachable, or if the start article changed; such changes
   usually mean a broken dump or a schema change, not a real change in
   Wikipedia.

   ```sh
   npm run graph -- compare --old 20261001 --new 20261101
   ```

5. **Verify** the build, including a couple of links you know exist.

   ```sh
   npm run graph -- verify --snapshot 20261101 \
     --expect-link Incremental_game Cookie_Clicker
   ```

6. **Upload.** Only immutable files under `snapshots/20261101/` are written;
   `latest.json` is not touched, so players see nothing yet. The upload
   checks every local file against the manifest first, uploads the manifest
   last, and can be interrupted and re-run: it continues where it stopped.

   ```sh
   npm run graph:publish -- --snapshot 20261101
   ```

   Add `--dry-run` to see what would be uploaded.

7. **Verify publicly.** Fetches the manifest and a sample of shards of every
   kind through the public address, as an allowed origin; checks hashes and
   decoding, looks up titles and links, and checks the `Cache-Control`,
   `Content-Type`, and CORS headers (allowed for the game's origins, refused
   for others).

   ```sh
   npm run graph:verify-public -- --snapshot 20261101 \
     --expect-link "Incremental game|Cookie Clicker"
   ```

   `--all` fetches every shard instead of a sample (3.4 GiB).

8. **Promote.** Repeats the public verification and then replaces
   `latest.json`. From then on new games start on the new snapshot.

   ```sh
   npm run graph:promote -- --snapshot 20261101
   npm run graph:verify-public -- --snapshot 20261101 --latest   # a minute later
   ```

To play the new snapshot locally before publishing it, run
`npm run graph -- promote --snapshot 20261101` and `npm run graph:serve`,
then start a new game (Reset Game, or a private window).

## Rules for published snapshots

- **A published snapshot is never modified.** Saves are pinned to a snapshot
  by the hash of its manifest, and browsers and the CDN cache its files for a
  year. `graph:publish` refuses to upload a snapshot whose ID is already in
  the bucket with different contents, and refuses to resume an upload with a
  different build than the one it started with. If a build has to change,
  give it a new ID: `build --source 20261101 --snapshot-id 20261101-2`.
- **Every published snapshot is kept.** Existing saves keep reading the
  snapshot they started on, indefinitely. Deleting a snapshot from the bucket
  breaks every save pinned to it. There is no delete command here on purpose.
- **`latest.json` is the only mutable object**, and only `graph:promote`
  writes it.
- **Rolling back** is promoting the previous snapshot again:
  `npm run graph:promote -- --snapshot 20261001`. Games started in the
  meantime stay on the snapshot they started with.

`graph:publish` uses `wrangler r2 bulk put`, which Wrangler currently labels
experimental. Wrangler is pinned by `package-lock.json`; after upgrading it,
run `npm test`, which rehearses a publish and a promotion through the real
Wrangler CLI against its local R2 simulation.

## How the game uses a snapshot

- A new game reads `latest.json`, then that snapshot's manifest, and stores
  the manifest and its hash in the save. From then on the save never looks at
  `latest.json` again: promoting a newer snapshot does not move existing
  players, whose opened-article bits would mean nothing in a graph with
  different numbering.
- Clicking a link looks the title up in one title bucket. Automatic opening
  reads adjacency files only, a whole neighbourhood at a time, and makes no
  request to Wikipedia at all.
- Every downloaded file is checked against the length and SHA-256 recorded
  for it. A mismatch is retried once past the HTTP cache; network failures
  are retried with backoff, and automation pauses and resumes by itself.
- The save lives in IndexedDB in the player's browser: the pinned snapshot,
  one bit per article for "opened" and one for "all links followed", the
  crawl position, and the usual game state. The Info panel has Export Save,
  Import Save, and Reset Game. Saves from before the graph existed
  (`localStorage`) are not migrated.
- The progress total is the article count of the pinned snapshot.

## Articles that cannot be reached

Some articles cannot be opened by following links, and the game does not
pretend otherwise. In the 20261001 snapshot, of 7,249,474 articles:

- 6,929,714 can be reached from the start article, *Incremental game*;
- 319,760 cannot. Of those, 282,133 have no incoming links from any article
  (orphans), including 1,171 with no links in either direction.

These articles are still counted in the total, so a player who follows every
link there is tops out at about 95.6%. This is intended: the total is the
real number of articles, and the pipeline reports the gap
(`reports/connectivity.json`, plus the exact lists as ordinal files) rather
than inventing links to close it. If that ever changes, it should be a game
design decision made with those reports in hand, not a change to the graph.

## Tests

```sh
npm test             # browser client, save format, game logic, publishing scripts
npm run graph:test   # the Rust pipeline
```

`fixtures/tiny/` holds a ten-article wiki as SQL dumps (`dumps/`), the
snapshot the builder produces from it (`public/`), and hand-written
expectations (`expected.json`). The Rust tests check that the builder turns
the dumps into exactly that snapshot and that it satisfies the expectations;
the browser tests read the same snapshot files through the same client code
the game uses. `npm run graph -- fixture --check` fails if the checked-in
snapshot no longer matches what the builder produces; after an intentional
format change, regenerate it with `npm run graph -- fixture` and review the
diff.
