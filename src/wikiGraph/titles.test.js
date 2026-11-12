import { describe, expect, it } from "vitest";

import { titleCases } from "../testing/fixtureGraph.js";
import {
  TITLE_HASH_NAME,
  bucketFor,
  formatTitle,
  hashTitle,
  normalizeTitle,
  titleBytes,
  titleFromHref,
} from "./titles.js";

describe("title hash", () => {
  it("is the hash the fixtures were built with", () => {
    expect(titleCases.hashName).toBe(TITLE_HASH_NAME);
  });

  it("matches the vectors shared with the Rust builder", () => {
    expect(titleCases.hash.length).toBeGreaterThanOrEqual(20);
    for (const { title, hash, bucketOf4, bucketOf8192 } of titleCases.hash) {
      const bytes = titleBytes(title);
      expect(hashTitle(bytes), `hash of ${JSON.stringify(title)}`).toBe(hash);
      expect(bucketFor(bytes, 4), `bucket of ${JSON.stringify(title)}`).toBe(bucketOf4);
      expect(bucketFor(bytes, 8192)).toBe(bucketOf8192);
    }
  });

  it("returns unsigned 32-bit values", () => {
    for (const { title } of titleCases.hash) {
      const hash = hashTitle(titleBytes(title));
      expect(Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff).toBe(true);
    }
  });
});

describe("normalizeTitle", () => {
  it("matches the vectors shared with the Rust builder", () => {
    expect(titleCases.normalize.length).toBeGreaterThanOrEqual(30);
    for (const { input, expected } of titleCases.normalize) {
      expect(normalizeTitle(input), `input ${JSON.stringify(input)}`).toBe(expected);
    }
  });

  it("is idempotent", () => {
    for (const { expected } of titleCases.normalize) {
      if (expected !== null) {
        expect(normalizeTitle(expected)).toBe(expected);
      }
    }
  });

  it("keeps case after the first letter", () => {
    expect(normalizeTitle("cookie clicker")).toBe("Cookie_clicker");
    expect(normalizeTitle("iPhone")).toBe("IPhone");
  });

  it("handles characters outside the basic multilingual plane", () => {
    expect(normalizeTitle("𐐨bc")).toBe("𐐀bc");
    expect(normalizeTitle("😀 face")).toBe("😀_face");
  });

  it("applies the 255-byte limit to UTF-8 bytes, not characters", () => {
    expect(normalizeTitle("a".repeat(255))).not.toBeNull();
    expect(normalizeTitle("a".repeat(256))).toBeNull();
    expect(normalizeTitle("é".repeat(127))).not.toBeNull();
    expect(normalizeTitle("é".repeat(128))).toBeNull();
  });

  it("rejects values that are not strings", () => {
    expect(normalizeTitle(null)).toBeNull();
    expect(normalizeTitle(undefined)).toBeNull();
    expect(normalizeTitle(7)).toBeNull();
  });
});

describe("titleFromHref", () => {
  it("extracts titles from Parsoid links", () => {
    expect(titleFromHref("./Cookie_Clicker")).toBe("Cookie_Clicker");
    expect(titleFromHref("./Caf%C3%A9#History")).toBe("Café");
    expect(titleFromHref("./AC%2FDC")).toBe("AC/DC");
    expect(titleFromHref("./What_Is_Life%3F")).toBe("What_Is_Life?");
    expect(titleFromHref("./Missing_page?action=edit&redlink=1")).toBe("Missing_page");
  });

  it("ignores links that do not point at a wiki page", () => {
    expect(titleFromHref("https://example.com/")).toBeNull();
    expect(titleFromHref("//example.com/")).toBeNull();
    expect(titleFromHref("#cite_note-1")).toBeNull();
    expect(titleFromHref("./#top")).toBeNull();
    expect(titleFromHref("./")).toBeNull();
    expect(titleFromHref("./%E0%A4%A")).toBeNull();
    expect(titleFromHref(null)).toBeNull();
  });
});

describe("formatTitle", () => {
  it("shows underscores as spaces", () => {
    expect(formatTitle("Incremental_game")).toBe("Incremental game");
  });
});
