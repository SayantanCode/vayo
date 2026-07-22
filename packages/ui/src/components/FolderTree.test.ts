import { describe, expect, it } from "vitest";
import { isBlockedGroupMove } from "./FolderTree.js";

describe("isBlockedGroupMove", () => {
  it("blocks a move to a different folder when the group is 'declared'", () => {
    expect(isBlockedGroupMove("declared", "folder_a", "folder_b")).toBe(true);
  });

  it("allows reordering within the same folder when the group is 'declared'", () => {
    expect(isBlockedGroupMove("declared", "folder_a", "folder_a")).toBe(false);
  });

  it("allows moving out to root when the group is 'declared' but the endpoint is already at root", () => {
    expect(isBlockedGroupMove("declared", null, null)).toBe(false);
  });

  it("blocks moving from root to a folder when the group is 'declared'", () => {
    expect(isBlockedGroupMove("declared", null, "folder_a")).toBe(true);
  });

  it("never blocks any move when the group is only 'inferred'", () => {
    expect(isBlockedGroupMove("inferred", "folder_a", "folder_b")).toBe(false);
    expect(isBlockedGroupMove("inferred", null, "folder_a")).toBe(false);
  });

  it("never blocks the first placement of a 'declared' endpoint that has no placement override yet at all", () => {
    // undefined (no folderId override exists yet) is distinct from null (an
    // explicit placement at root) — a brand new "declared" endpoint has
    // nothing to diverge from until it's actually been placed once.
    expect(isBlockedGroupMove("declared", undefined, "folder_a")).toBe(false);
    expect(isBlockedGroupMove("declared", undefined, null)).toBe(false);
  });

  it("blocks moving away from an explicit root placement ('declared', currently null) to any folder", () => {
    expect(isBlockedGroupMove("declared", null, "folder_a")).toBe(true);
  });
});
