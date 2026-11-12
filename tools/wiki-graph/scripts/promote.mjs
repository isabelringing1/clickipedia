// Points latest.json at a published snapshot, after verifying that snapshot
// over its public URL. New games start on it; existing saves do not move.
//
//   npm run graph:promote -- --snapshot 20261001 --bucket <bucket> --base-url https://graph.example.com/

import { parseArgs } from "node:util";

import { publicCheckOptions, publicOptions } from "./cli.mjs";
import { UsageError, checkSnapshotId, dataDir, runMain } from "./lib.mjs";
import { verifyPublicSnapshot } from "./publicCheck.mjs";
import { promoteSnapshot } from "./publishing.mjs";
import { createWrangler } from "./wrangler.mjs";

async function main() {
  const { values } = parseArgs({
    options: {
      ...publicOptions,
      bucket: { type: "string", default: process.env.WIKI_GRAPH_R2_BUCKET },
    },
  });
  if (!values.snapshot) {
    throw new UsageError("Pass --snapshot <id> to say which snapshot to promote.");
  }
  checkSnapshotId(values.snapshot);
  const checkOptions = publicCheckOptions(values);

  const result = await promoteSnapshot({
    bucket: values.bucket,
    snapshotId: values.snapshot,
    data: dataDir(values["data-dir"]),
    wrangler: createWrangler({ remote: true }),
    verifyPublic: () => verifyPublicSnapshot(checkOptions),
  });

  if (result.status === "promoted") {
    // latest.json is cached for a minute; confirm what the public sees.
    try {
      await verifyPublicSnapshot({ ...checkOptions, samples: 2, expectLatest: true });
    } catch (error) {
      if (!(error instanceof UsageError)) {
        throw error;
      }
      console.warn(
        `${error.message}\nlatest.json was uploaded, but the public copy does not show it yet. ` +
          "It is cached for up to a minute: run graph:verify-public with --latest shortly.",
      );
    }
  }
}

runMain(main);
