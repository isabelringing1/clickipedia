// Uploads a built snapshot to R2. Does not change latest.json.
//
//   npm run graph:publish -- --snapshot 20261001 --bucket <bucket>
//
// See tools/wiki-graph/README.md for the full refresh procedure.

import { parseArgs } from "node:util";

import { UsageError, checkSnapshotId, dataDir, runMain } from "./lib.mjs";
import { DEFAULT_BATCH_SIZE, DEFAULT_CONCURRENCY, DEFAULT_RATE, publishSnapshot } from "./publishing.mjs";
import { createWrangler } from "./wrangler.mjs";

async function main() {
  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" },
      bucket: { type: "string", default: process.env.WIKI_GRAPH_R2_BUCKET },
      "data-dir": { type: "string" },
      rate: { type: "string", default: String(DEFAULT_RATE) },
      batch: { type: "string", default: String(DEFAULT_BATCH_SIZE) },
      concurrency: { type: "string", default: String(DEFAULT_CONCURRENCY) },
      "dry-run": { type: "boolean", default: false },
      // Rehearse against Wrangler's local R2 simulation instead of Cloudflare.
      "local-persist-to": { type: "string" },
    },
  });
  if (!values.snapshot) {
    throw new UsageError("Pass --snapshot <id> to say which snapshot to publish.");
  }
  await publishSnapshot({
    bucket: values.bucket,
    snapshotId: checkSnapshotId(values.snapshot),
    data: dataDir(values["data-dir"]),
    wrangler: createWrangler(
      values["local-persist-to"] ? { persistTo: values["local-persist-to"] } : { remote: true },
    ),
    rate: Number(values.rate),
    batchSize: Number(values.batch),
    concurrency: Number(values.concurrency),
    dryRun: values["dry-run"],
  });
}

runMain(main);
