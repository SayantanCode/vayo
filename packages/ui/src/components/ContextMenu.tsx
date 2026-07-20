import { useRef } from "react";
import { useDismiss } from "../hooks/useDismiss.js";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  anchorX: number;
  anchorY: number;
  onClose: () => void;
}

export function ContextMenu({ items, anchorX, anchorY, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);

  return (
    <div ref={ref} className="context-menu" style={{ left: anchorX, top: anchorY }}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`context-menu__item ${item.danger ? "context-menu__item--danger" : ""}`}
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
