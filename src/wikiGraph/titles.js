// Title normalization and the title-bucket hash.
//
// Both functions mirror tools/wiki-graph/src/titles.rs. The shared vectors in
// tools/wiki-graph/fixtures/title-cases.json keep the two in lockstep.

export const TITLE_HASH_NAME = "fnv1a32-fmix32";
export const MAX_TITLE_BYTES = 255;

const encoder = new TextEncoder();

export function titleBytes(title) {
  return encoder.encode(title);
}

// FNV-1a over the UTF-8 bytes followed by the MurmurHash3 finalizer.
export function hashTitle(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function bucketFor(bytes, bucketCount) {
  return hashTitle(bytes) % bucketCount;
}

function isTitleWhitespace(code) {
  return (
    code === 0x20 ||
    code === 0x5f ||
    code === 0xa0 ||
    code === 0x1680 ||
    code === 0x180e ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

function isIgnoredFormatChar(code) {
  return code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e);
}

// Converts link text or a display title into MediaWiki database-key form for
// a first-letter-capitalizing wiki such as English Wikipedia. Returns null
// when nothing remains or the result exceeds 255 bytes.
export function normalizeTitle(input) {
  if (typeof input !== "string") {
    return null;
  }

  // A fragment never belongs to the title.
  const hash = input.indexOf("#");
  const withoutFragment = hash === -1 ? input : input.slice(0, hash);

  let collapsed = "";
  let pendingSeparator = false;
  for (const char of withoutFragment.normalize("NFC")) {
    const code = char.codePointAt(0);
    if (isIgnoredFormatChar(code)) {
      continue;
    }
    if (isTitleWhitespace(code)) {
      pendingSeparator = true;
      continue;
    }
    if (pendingSeparator && collapsed !== "") {
      collapsed += "_";
    }
    pendingSeparator = false;
    collapsed += char;
  }

  // A single leading colon forces a main-namespace link; drop it.
  let trimmed = collapsed;
  if (trimmed.startsWith(":")) {
    trimmed = trimmed.slice(1).replace(/^_+/, "");
  }
  if (trimmed === "") {
    return null;
  }

  const first = String.fromCodePoint(trimmed.codePointAt(0));
  const upper = first.toUpperCase();
  // Only apply simple one-to-one uppercase mappings (so "ß" stays "ß").
  const isSingleCodePoint = upper.length === String.fromCodePoint(upper.codePointAt(0)).length;
  const out = (isSingleCodePoint ? upper : first) + trimmed.slice(first.length);

  if (titleBytes(out).length > MAX_TITLE_BYTES) {
    return null;
  }
  return out;
}

// Turns the href of a link inside Parsoid article HTML ("./Cookie_Clicker",
// "./Caf%C3%A9#History") into the raw title it points at. Returns null for
// anything that is not a link to a wiki page.
export function titleFromHref(href) {
  if (typeof href !== "string" || !href.startsWith("./")) {
    return null;
  }
  const path = href.slice(2).split("#")[0].split("?")[0];
  if (path === "") {
    return null;
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

export function formatTitle(title) {
  return title.split("_").join(" ");
}
