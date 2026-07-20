import { describe, expect, it } from "vitest";
import {
  authModeFromDetected,
  detectFormat,
  extractPathname,
  findMatches,
  formatBytes,
  formatCell,
  getHeaderValue,
  isBinaryContentType,
  mostRecentOrPinned,
  parseForTable,
  pathSegmentsMatch,
  prettyPrintBody,
  prettyPrintXml,
} from "./try-it-now-utils.js";
import type { ExampleDoc } from "@vayo/types";

describe("pathSegmentsMatch", () => {
  it("matches a captured path with {param} placeholders against a literal path", () => {
    expect(pathSegmentsMatch("/api/v1/cart/items/item_1", "/api/v1/cart/items/{itemId}")).toBe(true);
  });

  it("does not match when the segment count differs", () => {
    expect(pathSegmentsMatch("/api/v1/cart", "/api/v1/cart/items/{itemId}")).toBe(false);
  });

  it("is case-insensitive on literal segments", () => {
    expect(pathSegmentsMatch("/API/V1/Cart", "/api/v1/cart")).toBe(true);
  });

  it("does not match a differing literal segment", () => {
    expect(pathSegmentsMatch("/api/v1/orders", "/api/v1/cart")).toBe(false);
  });
});

describe("extractPathname", () => {
  it("extracts the pathname from a full URL", () => {
    expect(extractPathname("http://localhost:4000/api/v1/cart/items")).toBe("/api/v1/cart/items");
  });

  it("falls back to slicing at the first slash when the URL constructor rejects the text outright — anything before that slash is dropped", () => {
    expect(extractPathname("api/v1/cart")).toBe("/v1/cart");
  });

  it("treats a bare host:port as a URL with that word as its scheme (new URL() accepts it) rather than throwing", () => {
    // Surprising but real: "localhost:4000/x" parses as scheme "localhost",
    // opaque path "4000/x" — new URL() doesn't throw here, so the catch-based
    // fallback never runs for this particular shape of input.
    expect(extractPathname("localhost:4000/api/v1/cart")).toBe("4000/api/v1/cart");
  });

  it("returns the text unchanged if there's no slash at all (still mid-typing)", () => {
    expect(extractPathname("localhost")).toBe("localhost");
  });
});

describe("detectFormat", () => {
  it("trusts an explicit JSON content-type over sniffing", () => {
    expect(detectFormat("not actually json", {}, false, "application/json")).toBe("json");
  });

  it("returns empty for a blank body regardless of content-type", () => {
    expect(detectFormat("   ", {}, false, "application/json")).toBe("empty");
  });

  it("sniffs JSON from a body starting with { when there's no content-type", () => {
    expect(detectFormat('{"id":1}', {}, false, null)).toBe("json");
  });

  it("falls through to markup sniffing when a { body isn't actually valid JSON", () => {
    expect(detectFormat("{not json at all", {}, false, null)).toBe("text");
  });

  it("detects a real HTML document by its doctype", () => {
    expect(detectFormat("<!DOCTYPE html><html><body>hi</body></html>", {}, false, null)).toBe("html");
  });

  it("detects XML with a leading declaration", () => {
    expect(detectFormat('<?xml version="1.0"?><root><a>1</a></root>', {}, false, null)).toBe("xml");
  });

  it("classifies a generic single-root markup body as XML, not HTML, when it has no HTML-specific tags", () => {
    // The exact bug fixed earlier this session: a body like <order><id>1</id></order>
    // was previously misclassified as HTML just for starting with "<".
    expect(detectFormat("<order><id>1</id><total>9.99</total></order>", {}, false, null)).toBe("xml");
  });

  it("classifies markup containing real HTML tags as HTML even without a doctype", () => {
    expect(detectFormat("<div><span>hi</span></div>", {}, false, null)).toBe("html");
  });

  it("returns image for a binary body with an image content-type", () => {
    expect(detectFormat("", {}, true, "image/png")).toBe("image");
  });

  it("returns binary for a binary body with a non-image content-type", () => {
    expect(detectFormat("", {}, true, "application/pdf")).toBe("binary");
  });

  it("falls back to text for plain, non-JSON, non-markup content", () => {
    expect(detectFormat("just some plain text", {}, false, null)).toBe("text");
  });
});

describe("isBinaryContentType", () => {
  it("treats image/audio/video types as binary", () => {
    expect(isBinaryContentType("image/png")).toBe(true);
    expect(isBinaryContentType("audio/mpeg")).toBe(true);
    expect(isBinaryContentType("video/mp4")).toBe(true);
  });

  it("treats common archive/office formats as binary", () => {
    expect(isBinaryContentType("application/zip")).toBe(true);
    expect(isBinaryContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(true);
  });

  it("does not treat JSON/XML/text as binary even though they're technically application/* sometimes", () => {
    expect(isBinaryContentType("application/json")).toBe(false);
    expect(isBinaryContentType("application/xml")).toBe(false);
    expect(isBinaryContentType("text/plain")).toBe(false);
  });

  it("returns false for a null content-type", () => {
    expect(isBinaryContentType(null)).toBe(false);
  });

  it("ignores charset suffixes when deciding", () => {
    expect(isBinaryContentType("text/html; charset=utf-8")).toBe(false);
  });
});

describe("getHeaderValue", () => {
  it("finds a header case-insensitively", () => {
    expect(getHeaderValue({ "Content-Type": "application/json" }, "content-type")).toBe("application/json");
  });

  it("returns null when the header isn't present", () => {
    expect(getHeaderValue({}, "x-request-id")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("formats bytes under 1KB plainly", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes with one decimal", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats megabytes with one decimal", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("prettyPrintXml", () => {
  it("indents nested elements", () => {
    const result = prettyPrintXml("<order><id>1</id><item><sku>A</sku></item></order>");
    expect(result).toBe("<order>\n  <id>1</id>\n  <item>\n    <sku>A</sku>\n  </item>\n</order>");
  });
});

describe("prettyPrintBody", () => {
  it("re-serializes JSON with 2-space indentation", () => {
    expect(prettyPrintBody('{"a":1,"b":2}', "json")).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it("falls back to the raw body when JSON parsing fails, rather than throwing", () => {
    expect(prettyPrintBody("{not json", "json")).toBe("{not json");
  });

  it("leaves a plain text body untouched", () => {
    expect(prettyPrintBody("hello world", "text")).toBe("hello world");
  });
});

describe("parseForTable", () => {
  it("accepts a non-empty array", () => {
    expect(parseForTable('[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("still returns an empty array (falls through to the generic object branch, since typeof [] === 'object')", () => {
    expect(parseForTable("[]")).toEqual([]);
  });

  it("rejects null", () => {
    expect(parseForTable("null")).toBeNull();
  });

  it("accepts a plain object", () => {
    expect(parseForTable('{"id":1}')).toEqual({ id: 1 });
  });

  it("rejects invalid JSON", () => {
    expect(parseForTable("not json")).toBeNull();
  });
});

describe("formatCell", () => {
  it("renders null/undefined as an em dash", () => {
    expect(formatCell(null)).toBe("—");
    expect(formatCell(undefined)).toBe("—");
  });

  it("stringifies nested objects/arrays as JSON", () => {
    expect(formatCell({ nested: true })).toBe('{"nested":true}');
  });

  it("converts primitives to plain strings", () => {
    expect(formatCell(42)).toBe("42");
    expect(formatCell(true)).toBe("true");
  });
});

describe("findMatches", () => {
  it("finds every case-insensitive occurrence of the query", () => {
    expect(findMatches("Price: price: PRICE", "price")).toEqual([0, 7, 14]);
  });

  it("returns an empty array for a blank query — the chicken-and-egg search-bar bug this guards against", () => {
    expect(findMatches("some text", "   ")).toEqual([]);
  });

  it("returns an empty array when there's no match", () => {
    expect(findMatches("some text", "xyz")).toEqual([]);
  });

  it("does not infinite-loop or double-count overlapping matches", () => {
    expect(findMatches("aaaa", "aa")).toEqual([0, 2]);
  });
});

describe("authModeFromDetected", () => {
  it("maps each known authType to its matching auth mode", () => {
    expect(authModeFromDetected("bearer")).toBe("bearer");
    expect(authModeFromDetected("basic")).toBe("basic");
    expect(authModeFromDetected("apiKey")).toBe("apiKey");
  });

  it("defaults to none for null/undefined/unknown", () => {
    expect(authModeFromDetected(null)).toBe("none");
    expect(authModeFromDetected(undefined)).toBe("none");
    expect(authModeFromDetected("something-else")).toBe("none");
  });
});

describe("mostRecentOrPinned", () => {
  function example(overrides: Partial<ExampleDoc>): ExampleDoc {
    return {
      _id: "ex_1",
      vayoId: "ep_1",
      statusCode: 200,
      requestBody: null,
      responseBody: null,
      capturedAt: "2026-01-01T00:00:00.000Z",
      redacted: false,
      pinned: false,
      label: null,
      ...overrides,
    };
  }

  it("returns null for an empty list", () => {
    expect(mostRecentOrPinned([])).toBeNull();
  });

  it("prefers a pinned example over a more recent unpinned one", () => {
    const pinned = example({ _id: "ex_pinned", pinned: true, capturedAt: "2026-01-01T00:00:00.000Z" });
    const recent = example({ _id: "ex_recent", pinned: false, capturedAt: "2026-06-01T00:00:00.000Z" });
    expect(mostRecentOrPinned([recent, pinned])?._id).toBe("ex_pinned");
  });

  it("falls back to the most recently captured example when nothing is pinned", () => {
    const older = example({ _id: "ex_older", capturedAt: "2026-01-01T00:00:00.000Z" });
    const newer = example({ _id: "ex_newer", capturedAt: "2026-06-01T00:00:00.000Z" });
    expect(mostRecentOrPinned([older, newer])?._id).toBe("ex_newer");
  });
});
