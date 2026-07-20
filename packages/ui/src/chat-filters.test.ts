import { describe, expect, it } from "vitest";
import { matchesDateFilter } from "./chat-filters.js";

// "today" is a LOCAL calendar-day boundary (setHours(0,0,0,0) on the
// machine's own timezone) — correct behavior (a user's "today" is their
// own local day, not UTC's), but it makes exact-midnight fixtures
// timezone-fragile in a test that has to run the same way in any CI/
// contributor timezone. Using offsets safely far from any real-world
// midnight (hours vs. multi-day) tests the same logic without that trap —
// which is also why NOW is anchored at local noon rather than the literal
// current instant: the literal instant would make "an hour ago" flaky if
// this suite happened to run between local midnight and 1am, landing it on
// the previous calendar day instead of "today".
const NOW = (() => {
  const anchor = new Date();
  anchor.setHours(12, 0, 0, 0);
  return anchor.getTime();
})();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("matchesDateFilter", () => {
  it("matches everything for 'all', regardless of age", () => {
    expect(matchesDateFilter(new Date(NOW - 1000 * DAY).toISOString(), "all", NOW)).toBe(true);
  });

  it("matches a message from an hour ago for 'today'", () => {
    expect(matchesDateFilter(new Date(NOW - HOUR).toISOString(), "today", NOW)).toBe(true);
  });

  it("does not match a message from 3 days ago for 'today'", () => {
    expect(matchesDateFilter(new Date(NOW - 3 * DAY).toISOString(), "today", NOW)).toBe(false);
  });

  it("matches a message from 3 days ago for 'week'", () => {
    expect(matchesDateFilter(new Date(NOW - 3 * DAY).toISOString(), "week", NOW)).toBe(true);
  });

  it("does not match a message from 10 days ago for 'week'", () => {
    expect(matchesDateFilter(new Date(NOW - 10 * DAY).toISOString(), "week", NOW)).toBe(false);
  });

  it("matches a message from 20 days ago for 'month'", () => {
    expect(matchesDateFilter(new Date(NOW - 20 * DAY).toISOString(), "month", NOW)).toBe(true);
  });

  it("does not match a message from 40 days ago for 'month'", () => {
    expect(matchesDateFilter(new Date(NOW - 40 * DAY).toISOString(), "month", NOW)).toBe(false);
  });

  it("defaults to the real current time when now isn't passed", () => {
    const recentIso = new Date().toISOString();
    expect(matchesDateFilter(recentIso, "today")).toBe(true);
  });
});
