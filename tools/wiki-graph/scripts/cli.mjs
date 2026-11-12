// Option handling shared by the verify-public and promote commands.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { TOOL_DIR, UsageError, dataDir, publicDir, sha256Hex } from "./lib.mjs";

export const publicOptions = {
  snapshot: { type: "string" },
  "base-url": { type: "string" },
  "data-dir": { type: "string" },
  origin: { type: "string", multiple: true },
  samples: { type: "string" },
  all: { type: "boolean", default: false },
  "allow-any-origin": { type: "boolean", default: false },
  "expect-link": { type: "string", multiple: true, default: [] },
};

export const CORS_POLICY_FILE = join(TOOL_DIR, "r2", "cors.json");

// The origins the bucket's CORS policy allows: the game's own origin and the
// local development servers. Read from the same file that is applied to the
// bucket, so verification checks exactly what was configured.
export function defaultOrigins() {
  const policy = JSON.parse(readFileSync(CORS_POLICY_FILE, "utf8"));
  return policy.rules.flatMap((rule) => rule.allowed.origins);
}

export function resolveBaseUrl(explicit) {
  const baseUrl =
    explicit ?? process.env.WIKI_GRAPH_PUBLIC_URL ?? process.env.VITE_WIKI_GRAPH_BASE_URL;
  if (!baseUrl) {
    throw new UsageError(
      "No public URL given. Pass --base-url or set WIKI_GRAPH_PUBLIC_URL to the bucket's public address.",
    );
  }
  return baseUrl;
}

// Links are given as "From title|To title".
export function parseExpectedLinks(values) {
  return values.map((value) => {
    const parts = value.split("|");
    if (parts.length !== 2 || parts.some((part) => part.trim() === "")) {
      throw new UsageError(`--expect-link takes "From title|To title", got "${value}".`);
    }
    return parts.map((part) => part.trim());
  });
}

// The hash of the locally built manifest, when this machine has the build.
// Verifying against it proves the public copy is the build that was checked.
export function localManifestSha256(data, snapshotId) {
  const path = join(publicDir(data), "snapshots", snapshotId, "manifest.json");
  return existsSync(path) ? sha256Hex(readFileSync(path)) : undefined;
}

export function publicCheckOptions(values) {
  const data = dataDir(values["data-dir"]);
  const manifestSha256 = localManifestSha256(data, values.snapshot);
  if (manifestSha256 === undefined) {
    console.warn(
      `warning: no local build of ${values.snapshot}; the public manifest cannot be compared with it.`,
    );
  }
  return {
    baseUrl: resolveBaseUrl(values["base-url"]),
    snapshotId: values.snapshot,
    manifestSha256,
    origins: values.origin?.length ? values.origin : defaultOrigins(),
    samples: values.samples === undefined ? undefined : Number(values.samples),
    all: values.all,
    allowAnyOrigin: values["allow-any-origin"],
    expectLinks: parseExpectedLinks(values["expect-link"]),
  };
}
