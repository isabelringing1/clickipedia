// Serves a local copy of the published layout for development.
//
//   npm run graph:serve                 the real build in data.nosync/public
//   npm run graph:serve -- --fixture    the tiny checked-in test snapshot
//
// It answers like the production bucket is configured to: the same
// Cache-Control and Content-Type values, and CORS only for allowed origins,
// so the game and `graph:verify-public` behave the same against both.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { defaultOrigins } from "./cli.mjs";
import {
  FIXTURE_PUBLIC_DIR,
  LATEST_KEY,
  UsageError,
  dataDir,
  objectHeaders,
  publicDir,
  runMain,
} from "./lib.mjs";

export const DEFAULT_PORT = 8787;

function isLocalOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

// `allowedOrigins` lists extra origins; localhost on any port is always
// allowed. `noStore` disables caching of snapshot files, which is useful
// while rebuilding the same snapshot ID during pipeline development.
export function createGraphServer({ dir, allowedOrigins = [], noStore = false }) {
  return createServer((request, response) => {
    const origin = request.headers.origin;
    response.setHeader("Vary", "Origin");
    if (origin && (isLocalOrigin(origin) || allowedOrigins.includes(origin))) {
      response.setHeader("Access-Control-Allow-Origin", origin);
    }

    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD, OPTIONS" }).end();
      return;
    }

    let key;
    try {
      key = decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice(1));
    } catch {
      response.writeHead(400).end();
      return;
    }
    // Refuse anything that is not a plain relative path inside `dir`.
    const path = join(dir, normalize(key));
    if (key === "" || key.includes("\0") || !path.startsWith(dir + sep)) {
      response.writeHead(404).end();
      return;
    }

    let headers;
    try {
      headers = objectHeaders(key);
    } catch {
      response.writeHead(404).end();
      return;
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end("not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": headers.contentType,
      "Content-Length": statSync(path).size,
      "Cache-Control": noStore && key !== LATEST_KEY ? "no-store" : headers.cacheControl,
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(path).pipe(response);
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixture: { type: "boolean", default: false },
      dir: { type: "string" },
      "data-dir": { type: "string" },
      port: { type: "string", default: String(DEFAULT_PORT) },
      origin: { type: "string", multiple: true, default: [] },
      "no-store": { type: "boolean", default: false },
    },
  });
  const dir = values.dir ?? (values.fixture ? FIXTURE_PUBLIC_DIR : publicDir(dataDir(values["data-dir"])));
  if (!existsSync(join(dir, LATEST_KEY))) {
    throw new UsageError(
      `${dir} has no latest.json. Build and promote a snapshot locally first ` +
        "(npm run graph -- promote --snapshot <id>), or pass --fixture.",
    );
  }
  const port = Number(values.port);
  const server = createGraphServer({
    dir,
    // The origins of the bucket's CORS policy, so that the same
    // graph:verify-public command works against this server.
    allowedOrigins: [...defaultOrigins(), ...values.origin],
    noStore: values["no-store"],
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Serving ${dir}`);
    console.log(`  VITE_WIKI_GRAPH_BASE_URL=http://localhost:${port}/`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain(main);
}
