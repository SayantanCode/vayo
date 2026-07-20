// @vayo/ui — Team Chat's date/time filter, pulled out as pure functions
// (same reasoning as mentions.ts) so the actual date-window logic is
// unit-testable without mounting the component.

export type DateFilter = "all" | "today" | "week" | "month";

export const DATE_FILTER_LABELS: Record<DateFilter, string> = {
  all: "All time",
  today: "Today",
  week: "Last 7 days",
  month: "Last 30 days",
};

export const DATE_FILTERS: readonly DateFilter[] = ["all", "today", "week", "month"];

/** `now` is injectable purely for testability — every real call site omits
 * it and gets the actual current time. */
export function matchesDateFilter(createdAt: string, filter: DateFilter, now: number = Date.now()): boolean {
  if (filter === "all") return true;
  const created = new Date(createdAt).getTime();
  if (filter === "today") {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    return created >= startOfToday.getTime();
  }
  const days = filter === "week" ? 7 : 30;
  return now - created <= days * 24 * 60 * 60 * 1000;
}
