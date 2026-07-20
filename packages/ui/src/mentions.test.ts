import { describe, expect, it } from "vitest";
import {
  applyMentionSelection,
  detectMentionTrigger,
  formatEndpointTagToken,
  formatMentionToken,
  parseMentions,
} from "./mentions.js";

describe("formatMentionToken", () => {
  it("wraps a name and member id in the stored token syntax", () => {
    expect(formatMentionToken("Editor Ed", "member_42")).toBe("@[Editor Ed](member_42)");
  });
});

describe("formatEndpointTagToken", () => {
  it("wraps a path and vayoId in the stored token syntax", () => {
    expect(formatEndpointTagToken("/api/v1/orders", "ep_42")).toBe("#[/api/v1/orders](ep_42)");
  });
});

describe("parseMentions", () => {
  it("returns a single text segment for a message with no references", () => {
    expect(parseMentions("just a plain message")).toEqual([{ type: "text", content: "just a plain message" }]);
  });

  it("splits text around a single mention", () => {
    expect(parseMentions("hey @[Editor Ed](member_42) can you check this?")).toEqual([
      { type: "text", content: "hey " },
      { type: "mention", content: "Editor Ed", memberId: "member_42" },
      { type: "text", content: " can you check this?" },
    ]);
  });

  it("splits text around a single endpoint tag", () => {
    expect(parseMentions("does #[/api/v1/orders](ep_1) need auth?")).toEqual([
      { type: "text", content: "does " },
      { type: "endpoint", content: "/api/v1/orders", vayoId: "ep_1" },
      { type: "text", content: " need auth?" },
    ]);
  });

  it("handles a mention with nothing before it", () => {
    expect(parseMentions("@[Editor Ed](member_42) fix this please")).toEqual([
      { type: "mention", content: "Editor Ed", memberId: "member_42" },
      { type: "text", content: " fix this please" },
    ]);
  });

  it("handles a mention with nothing after it", () => {
    expect(parseMentions("cc @[Editor Ed](member_42)")).toEqual([
      { type: "text", content: "cc " },
      { type: "mention", content: "Editor Ed", memberId: "member_42" },
    ]);
  });

  it("handles multiple mentions in one message", () => {
    expect(parseMentions("@[Alice](m1) and @[Bob](m2) please look")).toEqual([
      { type: "mention", content: "Alice", memberId: "m1" },
      { type: "text", content: " and " },
      { type: "mention", content: "Bob", memberId: "m2" },
      { type: "text", content: " please look" },
    ]);
  });

  it("handles a mention and an endpoint tag interleaved in one message", () => {
    expect(parseMentions("@[Editor Ed](m1) does #[/api/v1/orders](ep_1) relate to #[/api/v1/cart](ep_2)?")).toEqual([
      { type: "mention", content: "Editor Ed", memberId: "m1" },
      { type: "text", content: " does " },
      { type: "endpoint", content: "/api/v1/orders", vayoId: "ep_1" },
      { type: "text", content: " relate to " },
      { type: "endpoint", content: "/api/v1/cart", vayoId: "ep_2" },
      { type: "text", content: "?" },
    ]);
  });

  it("returns an empty array for an empty body", () => {
    expect(parseMentions("")).toEqual([]);
  });
});

describe("detectMentionTrigger", () => {
  it("detects an active mention trigger right after a bare @", () => {
    expect(detectMentionTrigger("hey @", 5)).toEqual({ kind: "mention", start: 4, query: "" });
  });

  it("detects an active mention trigger with a partial name typed", () => {
    expect(detectMentionTrigger("hey @ed", 7)).toEqual({ kind: "mention", start: 4, query: "ed" });
  });

  it("detects an active endpoint-tag trigger right after a bare #", () => {
    expect(detectMentionTrigger("does #", 6)).toEqual({ kind: "endpoint", start: 5, query: "" });
  });

  it("detects an active endpoint-tag trigger with a partial path typed", () => {
    expect(detectMentionTrigger("does #orders", 12)).toEqual({ kind: "endpoint", start: 5, query: "orders" });
  });

  it("returns null when there's no sigil at all", () => {
    expect(detectMentionTrigger("just typing normally", 10)).toBeNull();
  });

  it("returns null once a space follows the sigil (reference abandoned)", () => {
    expect(detectMentionTrigger("hey @ everyone", 14)).toBeNull();
    expect(detectMentionTrigger("hey # everyone", 14)).toBeNull();
  });

  it("finds whichever sigil is closest to the cursor when both appear", () => {
    expect(detectMentionTrigger("@[Alice](m1) also #or", 22)).toEqual({ kind: "endpoint", start: 18, query: "or" });
    expect(detectMentionTrigger("#[/x](ep_1) also @bo", 20)).toEqual({ kind: "mention", start: 17, query: "bo" });
  });

  it("returns null right after a completed reference token with no new sigil yet", () => {
    expect(detectMentionTrigger("@[Alice](m1) ", 13)).toBeNull();
  });
});

describe("applyMentionSelection", () => {
  it("replaces the partial @query with the full mention token and a trailing space", () => {
    const result = applyMentionSelection("hey @ed", { kind: "mention", start: 4, query: "ed" }, "Editor Ed", "member_42");
    expect(result.text).toBe("hey @[Editor Ed](member_42) ");
    expect(result.cursorIndex).toBe(result.text.length);
  });

  it("replaces the partial #query with the full endpoint-tag token and a trailing space", () => {
    const result = applyMentionSelection("does #ord", { kind: "endpoint", start: 5, query: "ord" }, "/api/v1/orders", "ep_1");
    expect(result.text).toBe("does #[/api/v1/orders](ep_1) ");
    expect(result.cursorIndex).toBe(result.text.length);
  });

  it("preserves text typed after the trigger position", () => {
    const result = applyMentionSelection("hey @ed can you", { kind: "mention", start: 4, query: "ed" }, "Editor Ed", "member_42");
    expect(result.text).toBe("hey @[Editor Ed](member_42)  can you");
  });

  it("works when the trigger is a bare sigil with no query yet", () => {
    const result = applyMentionSelection("hey @", { kind: "mention", start: 4, query: "" }, "Editor Ed", "member_42");
    expect(result.text).toBe("hey @[Editor Ed](member_42) ");
  });
});
