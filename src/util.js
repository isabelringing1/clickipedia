import { formatTitle } from "./wikiGraph/titles.js";

const formatTopic = formatTitle;

const MAX_CONCURRENT_REQUESTS = 3;
const REQUEST_START_INTERVAL_MS = 350;
const MAX_RETRIES = 4;
const MAX_ARTICLE_CACHE_ENTRIES = 50;
const CATEGORY_PREFIX = "./Category:";

const requestQueue = [];
const articleContentCache = new Map();
let activeRequests = 0;
let nextRequestAt = 0;
let blockedUntil = 0;
let drainTimer = null;

function drainRequestQueue() {
  if (drainTimer != null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }

  if (
    requestQueue.length === 0 ||
    activeRequests >= MAX_CONCURRENT_REQUESTS
  ) {
    return;
  }

  const wait = Math.max(nextRequestAt, blockedUntil) - Date.now();
  if (wait > 0) {
    drainTimer = setTimeout(drainRequestQueue, wait);
    return;
  }

  const request = requestQueue.shift();
  activeRequests += 1;
  nextRequestAt = Date.now() + REQUEST_START_INTERVAL_MS;

  Promise.resolve()
    .then(request.run)
    .then(request.resolve, request.reject)
    .finally(() => {
      activeRequests -= 1;
      drainRequestQueue();
    });

  drainRequestQueue();
}

function scheduleRequest(run) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ run, resolve, reject });
    drainRequestQueue();
  });
}

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return seconds * 1000;
    }

    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }

  return Math.min(5000 * 2 ** attempt, 60000);
}

async function fetchWithPolicy(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await scheduleRequest(() => fetch(url));

    if (response.status !== 429 && response.status !== 503) {
      if (!response.ok) {
        throw new Error(`Wikimedia request failed with HTTP ${response.status}`);
      }
      return response;
    }

    const delay = retryDelay(response, attempt);
    blockedUntil = Math.max(blockedUntil, Date.now() + delay);
    drainRequestQueue();
  }

  throw new Error("Wikimedia request failed after repeated rate limits");
}

function articleUrl(topic) {
  return `https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(topic)}`;
}

// Turns the href of a category marker in article HTML, such as
// "./Category:Countries_in_East_Asia#Japan", into the category's name
// ("Countries in East Asia"). Returns null for anything else.
function categoryFromHref(href) {
  if (typeof href !== "string" || !href.startsWith(CATEGORY_PREFIX)) {
    return null;
  }
  const encoded = href.slice(CATEGORY_PREFIX.length).split("#")[0];
  let name;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  name = name.split("_").join(" ").trim();
  return name === "" ? null : name;
}

// Article HTML lists the page's categories as <link> elements, so quests can
// be checked from the page the player is reading without a second request.
function extractCategories(doc) {
  const categories = new Set();
  doc.querySelectorAll('link[rel~="mw:PageProp/Category"]').forEach((link) => {
    const category = categoryFromHref(link.getAttribute("href"));
    if (category !== null) {
      categories.add(category);
    }
  });
  return [...categories];
}

// Loads an article for the player to read. This is the only request the game
// makes to Wikipedia: which links exist, and which articles automation opens,
// come from the published link graph instead.
async function fetchWikiPage(topic) {
  const url = articleUrl(topic);

  try {
    let request = articleContentCache.get(url);
    if (request) {
      // Refresh the entry's insertion order so the least recently used article
      // is removed first.
      articleContentCache.delete(url);
      articleContentCache.set(url, request);
    } else {
      request = fetchWithPolicy(url)
        .then((response) => response.text())
        .catch((error) => {
          articleContentCache.delete(url);
          throw error;
        });
      articleContentCache.set(url, request);

      while (articleContentCache.size > MAX_ARTICLE_CACHE_ENTRIES) {
        articleContentCache.delete(articleContentCache.keys().next().value);
      }
    }

    const html = await request;
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    return { html: doc.body.innerHTML, categories: extractCategories(doc) };
  } catch (err) {
    console.error("Failed to load page:", err);
    return { html: "<p>Failed to load page.</p>", categories: [] };
  }
}

function evictWikiPage(topic) {
  articleContentCache.delete(articleUrl(topic));
}

export { formatTopic, fetchWikiPage, evictWikiPage, categoryFromHref };
