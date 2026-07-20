import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { EndpointSummary } from "../types.js";
import {
  availableGroups,
  availableMethods,
  EMPTY_ENDPOINT_FILTERS,
  hasActiveEndpointFilters,
  matchesEndpointFilters,
  type AuthFilter,
  type EndpointFilters,
} from "../endpoint-filters.js";
import { useDismiss } from "../hooks/useDismiss.js";

interface CommandPaletteProps {
  endpoints: EndpointSummary[];
  onSelect: (vayoId: string) => void;
  onClose: () => void;
}

const AUTH_FILTER_LABELS: Record<AuthFilter, string> = {
  any: "Any auth",
  required: "Auth required",
  "not-required": "No auth",
};

/** A themed stand-in for a native `<select>` — browsers render a `<select>`'s
 * open listbox with their own OS-level popup that CSS can barely touch (no
 * matching our dark surface or accent color), which looked visibly out of
 * place next to the rest of the palette. Closes on an outside click or
 * Escape, same as the other transient popovers in this app. */
function GroupFilterMenu({
  groups,
  value,
  onChange,
}: {
  groups: string[];
  value: string | null;
  onChange: (group: string | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, () => setOpen(false), open);

  return (
    <div ref={ref} className="command-palette__group-menu">
      <button
        type="button"
        className={`command-palette__group-trigger ${value ? "command-palette__group-trigger--active" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        {value ?? "All groups"}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="command-palette__group-dropdown">
          <button
            type="button"
            className={`command-palette__group-option ${value === null ? "command-palette__group-option--active" : ""}`}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            All groups
          </button>
          {groups.map((group) => (
            <button
              key={group}
              type="button"
              className={`command-palette__group-option ${value === group ? "command-palette__group-option--active" : ""}`}
              onClick={() => {
                onChange(group);
                setOpen(false);
              }}
            >
              {group}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Substring match wins outright; otherwise a simple in-order subsequence
 * match (every query character appears, in order, somewhere in target) —
 * good enough for a short endpoint list, no fuzzy-search dependency needed. */
function matchScore(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) return 1000 - idx;

  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length ? 1 : -1;
}

export function CommandPalette({ endpoints, onSelect, onClose }: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [filters, setFilters] = useState<EndpointFilters>(EMPTY_ENDPOINT_FILTERS);

  const methods = useMemo(() => availableMethods(endpoints), [endpoints]);
  const groups = useMemo(() => availableGroups(endpoints), [endpoints]);
  const filtersActive = hasActiveEndpointFilters(filters);

  const results = useMemo(() => {
    const candidates = endpoints.filter((e) => matchesEndpointFilters(e, filters));
    if (!query.trim()) return candidates.slice(0, 20);
    return candidates
      .map((endpoint) => ({
        endpoint,
        score: Math.max(
          matchScore(query, endpoint.path),
          matchScore(query, endpoint.summary ?? ""),
          matchScore(query, endpoint.group),
        ),
      }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((r) => r.endpoint);
  }, [query, endpoints, filters]);

  function toggleMethod(method: string) {
    setFilters((prev) => ({
      ...prev,
      methods: prev.methods.includes(method) ? prev.methods.filter((m) => m !== method) : [...prev.methods, method],
    }));
  }

  function cycleAuthFilter() {
    setFilters((prev) => ({
      ...prev,
      auth: prev.auth === "any" ? "required" : prev.auth === "required" ? "not-required" : "any",
    }));
  }

  useEffect(() => setActiveIndex(0), [query, filters]);

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = results[activeIndex];
      if (selected) onSelect(selected.vayoId);
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette__input-row">
          <Search size={16} />
          <input
            name="commandPaletteQuery"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search endpoints…"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-palette__filters">
          {methods.map((method) => (
            <button
              key={method}
              type="button"
              className={`command-palette__filter-chip method-badge--${method.toLowerCase()} ${filters.methods.includes(method) ? "command-palette__filter-chip--active" : ""}`}
              onClick={() => toggleMethod(method)}
            >
              {method}
            </button>
          ))}
          <button
            type="button"
            className={`command-palette__filter-chip command-palette__filter-chip--auth ${filters.auth !== "any" ? "command-palette__filter-chip--active" : ""}`}
            onClick={cycleAuthFilter}
          >
            {AUTH_FILTER_LABELS[filters.auth]}
          </button>
          {groups.length > 1 && (
            <GroupFilterMenu
              groups={groups}
              value={filters.group}
              onChange={(group) => setFilters((prev) => ({ ...prev, group }))}
            />
          )}
          {filtersActive && (
            <button type="button" className="link-button command-palette__clear-filters" onClick={() => setFilters(EMPTY_ENDPOINT_FILTERS)}>
              Clear filters
            </button>
          )}
        </div>
        <div className="command-palette__results">
          {results.map((endpoint, index) => (
            <button
              key={endpoint.vayoId}
              type="button"
              className={`command-palette__result ${index === activeIndex ? "command-palette__result--active" : ""}`}
              onClick={() => onSelect(endpoint.vayoId)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span className={`method-badge method-badge--${endpoint.method.toLowerCase()}`}>{endpoint.method}</span>
              <span className="command-palette__result-name">{endpoint.summary || endpoint.path}</span>
              <span className="muted">{endpoint.group}</span>
            </button>
          ))}
          {results.length === 0 && (
            <p className="muted command-palette__empty">{filtersActive ? "No endpoints match these filters." : "No matches."}</p>
          )}
        </div>
      </div>
    </div>
  );
}
