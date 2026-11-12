// Where the published link graph lives. This is a public URL, not a secret:
// R2 credentials stay on the machine that publishes snapshots and must never
// be exposed through a VITE_ variable.
export function graphBaseUrl() {
  return import.meta.env?.VITE_WIKI_GRAPH_BASE_URL ?? "";
}
