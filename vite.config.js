import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The game cannot start without the address of the link graph, and that
// address is compiled into the bundle. Refuse to produce a production build
// that would show every player an error screen.
function checkGraphUrl(command, mode) {
  if (command !== "build" || mode !== "production") {
    return;
  }
  const root = fileURLToPath(new URL(".", import.meta.url));
  const url = loadEnv(mode, root, "VITE_").VITE_WIKI_GRAPH_BASE_URL;
  if (!url) {
    throw new Error(
      "VITE_WIKI_GRAPH_BASE_URL is not set. Put the public address of the link graph " +
        "in .env.production.local (see .env.example and tools/wiki-graph/README.md).",
    );
  }
  if (!url.startsWith("https://")) {
    throw new Error(
      `VITE_WIKI_GRAPH_BASE_URL is "${url}", which players cannot reach. A production ` +
        "build needs the https address of the published link graph.",
    );
  }
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  checkGraphUrl(command, mode);
  return {
    plugins: [react()],
    base: "/clickipedia/", //TODO: Remove when launching url?
    test: {
      environment: "node",
      include: ["src/**/*.test.js", "tools/wiki-graph/scripts/**/*.test.mjs"],
    },
  };
});
