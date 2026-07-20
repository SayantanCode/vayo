// @vayo/ui — Light/Dark/System theme toggle. "System" leaves `data-theme`
// unset so the `prefers-color-scheme` media query in theme.css governs;
// Light/Dark stamp `data-theme` on <html>, which the same file's
// `:root[data-theme="..."]` overrides win against in both directions.
// Persisted to localStorage so a manual choice survives a reload.

import { Moon, Sun, MonitorSmartphone } from "lucide-react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "vayo:theme";

export function applyStoredTheme(): void {
  const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
  applyTheme(stored ?? "system");
}

function applyTheme(mode: ThemeMode): void {
  if (mode === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", mode);
  }
}

function currentTheme(): ThemeMode {
  return (localStorage.getItem(STORAGE_KEY) as ThemeMode | null) ?? "system";
}

interface ThemeToggleProps {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}

const OPTIONS: Array<{ mode: ThemeMode; label: string; Icon: typeof Sun }> = [
  { mode: "light", label: "Light", Icon: Sun },
  { mode: "dark", label: "Dark", Icon: Moon },
  { mode: "system", label: "Match system", Icon: MonitorSmartphone },
];

export function ThemeToggle({ value, onChange }: ThemeToggleProps): JSX.Element {
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {OPTIONS.map(({ mode, label, Icon }) => (
        <button
          key={mode}
          type="button"
          title={label}
          aria-label={label}
          className={`theme-toggle__option ${value === mode ? "theme-toggle__option--active" : ""}`}
          onClick={() => {
            localStorage.setItem(STORAGE_KEY, mode);
            applyTheme(mode);
            onChange(mode);
          }}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}

export { currentTheme };
