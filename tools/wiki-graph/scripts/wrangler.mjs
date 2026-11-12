// Runs the project's pinned Wrangler.
//
// Authentication is Wrangler's own: `wrangler login` on this machine, or a
// CLOUDFLARE_API_TOKEN in the environment of the shell that runs the script.
// These scripts never read, store, log, or pass credentials themselves.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { REPO_DIR, UsageError } from "./lib.mjs";

const KEY_MISSING = "The specified key does not exist.";

function wranglerBin() {
  const require = createRequire(join(REPO_DIR, "package.json"));
  let packagePath;
  try {
    packagePath = require.resolve("wrangler/package.json");
  } catch {
    throw new UsageError("Wrangler is not installed. Run `npm install` in the repository root.");
  }
  const { bin, version } = JSON.parse(readFileSync(packagePath, "utf8"));
  const major = Number(version.split(".")[0]);
  if (!(major >= 4)) {
    throw new UsageError(`Wrangler ${version} is installed; version 4 or newer is required.`);
  }
  const relative = typeof bin === "string" ? bin : bin.wrangler;
  return join(dirname(packagePath), relative);
}

// `target` selects where objects go: { remote: true } for Cloudflare, or
// { persistTo: dir } for Wrangler's local R2 simulation (used by tests and
// rehearsals; it needs no account).
export function createWrangler(target = { remote: true }) {
  const bin = wranglerBin();
  const targetArgs = target.remote ? ["--remote"] : ["--local", "--persist-to", target.persistTo];

  function run(args, { capture = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args, ...targetArgs], {
        cwd: REPO_DIR,
        stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
      });
      const stdout = [];
      const stderr = [];
      child.stdout?.on("data", (chunk) => stdout.push(chunk));
      child.stderr?.on("data", (chunk) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({
          code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
  }

  return {
    // Returns the object's bytes, or null when the key does not exist. Any
    // other failure throws: "could not tell" must never be read as "absent".
    async getObject(bucket, key) {
      const result = await run(["r2", "object", "get", `${bucket}/${key}`, "--pipe"], {
        capture: true,
      });
      if (result.code === 0) {
        return result.stdout;
      }
      const output = result.stderr + result.stdout.toString("utf8");
      if (output.includes(KEY_MISSING)) {
        return null;
      }
      throw new UsageError(
        `Wrangler could not read ${bucket}/${key}:\n${output.trim()}\n` +
          "If you are not signed in, run `npx wrangler login` and try again.",
      );
    },

    async putObject(bucket, key, file, { contentType, cacheControl }) {
      const result = await run([
        "r2",
        "object",
        "put",
        `${bucket}/${key}`,
        "--file",
        file,
        "--content-type",
        contentType,
        "--cache-control",
        cacheControl,
        "--force",
      ]);
      if (result.code !== 0) {
        throw new UsageError(`Wrangler failed to upload ${key} (exit code ${result.code}).`);
      }
    },

    // Uploads many objects that share HTTP metadata. `listFile` is a JSON
    // array of { key, file }.
    async bulkPut(bucket, listFile, { contentType, cacheControl, concurrency }) {
      const result = await run([
        "r2",
        "bulk",
        "put",
        bucket,
        "--filename",
        listFile,
        "--content-type",
        contentType,
        "--cache-control",
        cacheControl,
        "--concurrency",
        String(concurrency),
        "--force",
      ]);
      if (result.code !== 0) {
        throw new UsageError(`Wrangler failed to upload a batch (exit code ${result.code}).`);
      }
    },
  };
}
