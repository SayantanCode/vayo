import { useRef, type ReactNode } from "react";
import { useDismiss } from "../hooks/useDismiss.js";

interface ModalProps {
  onClose: () => void;
  /** Additional class(es) appended to the base "modal" class on the panel —
   * e.g. "env-modal", "diff-modal" — for a modal that needs its own extra
   * sizing/layout on top of the shared look. */
  className?: string;
  children: ReactNode;
}

/** The shared backdrop + panel shell every modal in this app uses —
 * previously each modal reimplemented its own `.modal-overlay` +
 * `onClick={onClose}` + `stopPropagation()` by hand, with no Escape-key
 * support anywhere. `useDismiss` on the panel itself replaces both: a click
 * on the backdrop is a click outside the panel (closes), a click inside the
 * panel doesn't propagate to anything that would (no stopPropagation
 * needed), and Escape now closes every modal that uses this, not none of
 * them.
 *
 * A modal that needs a `<form onSubmit>` renders that form as this
 * component's child, inside the panel div, rather than the panel itself
 * being a form — one extra level of nesting that changes nothing visually
 * (CSS here is all descendant selectors) and keeps this component's own
 * element type fixed. */
export function Modal({ onClose, className, children }: ModalProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);

  return (
    <div className="modal-overlay">
      <div ref={ref} className={["modal", className].filter(Boolean).join(" ")}>
        {children}
      </div>
    </div>
  );
}
