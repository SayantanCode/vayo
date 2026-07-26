import { describe, expect, it } from "vitest";
import type { ApiVersionDoc } from "@vayo-hq/types";
import { isDefaultVersionPhantom } from "./VersionSwitcher.js";

function version(v: string): ApiVersionDoc {
  return {
    _id: `id_${v}`,
    version: v,
    basePathPattern: `/api/${v}`,
    status: "active",
    deprecatedAt: null,
    sunsetAt: null,
  };
}

describe("isDefaultVersionPhantom", () => {
  it("is phantom when no ApiVersionDoc exists yet for the default version", () => {
    expect(isDefaultVersionPhantom("v1", [])).toBe(true);
  });

  it("is not phantom once a real ApiVersionDoc exists for it", () => {
    expect(isDefaultVersionPhantom("v1", [version("v1")])).toBe(false);
  });

  it("is not phantom when other versions exist but not the default one — still surfaced separately", () => {
    // This case is still "phantom" (true) since v1 itself isn't a real
    // version yet, even though v2 is — the whole point is that v1 needs
    // to be synthesized regardless of what else exists.
    expect(isDefaultVersionPhantom("v1", [version("v2")])).toBe(true);
  });

  it("is never phantom for 'unversioned' — it's already unconditionally rendered", () => {
    expect(isDefaultVersionPhantom("unversioned", [])).toBe(false);
  });
});
