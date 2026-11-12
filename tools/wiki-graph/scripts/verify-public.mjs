// Checks a published snapshot over its public URL, as browsers will read it.
//
//   npm run graph:verify-public -- --snapshot 20261001 --base-url https://graph.example.com/
//
// Add --latest after promoting to also check latest.json, --all to fetch
// every shard instead of a sample.

import { parseArgs } from "node:util";

import { publicCheckOptions, publicOptions } from "./cli.mjs";
import { UsageError, checkSnapshotId, runMain } from "./lib.mjs";
import { verifyPublicSnapshot } from "./publicCheck.mjs";

async function main() {
  const { values } = parseArgs({
    options: { ...publicOptions, latest: { type: "boolean", default: false } },
  });
  if (!values.snapshot) {
    throw new UsageError("Pass --snapshot <id> to say which snapshot to verify.");
  }
  checkSnapshotId(values.snapshot);
  await verifyPublicSnapshot({ ...publicCheckOptions(values), expectLatest: values.latest });
}

runMain(main);
