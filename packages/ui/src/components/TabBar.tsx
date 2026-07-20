import type { TabId } from "../types.js";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "details", label: "Details" },
  { id: "flowmap", label: "Flowmap" },
  { id: "history", label: "History" },
  { id: "chat", label: "Team Chat" },
  { id: "tryit", label: "Try It Now" },
];

export function TabBar({ active, onChange }: { active: TabId; onChange: (tab: TabId) => void }): JSX.Element {
  return (
    <div className="tab-bar">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`tab-bar__tab ${active === tab.id ? "tab-bar__tab--active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
