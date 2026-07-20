// @vayo/ui — per-endpoint Markdown/Mermaid notes: documents how an
// endpoint fits into a larger frontend workflow (e.g. cascading-dropdown
// dependencies between endpoints), authored in Markdown with embedded
// Mermaid diagram support. Stored via the same override mechanism as
// every other field (`${vayoId}.notes`) — no dedicated backend route.

import { useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { insertNewline } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import type { ApiConfig } from "../api.js";
import { api } from "../api.js";

interface EndpointNotesProps {
  vayoId: string;
  notes: string | null;
  config: ApiConfig;
  canEdit: boolean;
}

// Two layers of "smart" editing fight a plain markdown-source editor here:
// `addKeymap` (on by default) installs Enter-triggered smart list
// continuation, and CodeMirror's own default Enter binding
// (`insertNewlineAndIndent`) copies/grows the previous line's indentation —
// both actively mangle typed/pasted structured content like tables and
// fenced code blocks (a multi-line ```mermaid block drifts one extra indent
// per line). Enter is force-bound to a plain `insertNewline` at the highest
// precedence so this editor behaves like a real plain-text area for
// markdown source, which is what writing a table/mermaid block needs.
const MARKDOWN_EXTENSIONS = [markdown({ addKeymap: false }), Prec.highest(keymap.of([{ key: "Enter", run: insertNewline }]))];

// Mermaid pulls in a large per-diagram-type runtime (flowchart/sequence/
// gantt/etc. each code-split, but its core alone is still substantial) —
// dynamically imported here so the cost is only paid the moment a note
// actually contains a ```mermaid block, not on every page load.
let mermaidModulePromise: Promise<typeof import("mermaid")["default"]> | null = null;
function loadMermaid(): Promise<typeof import("mermaid")["default"]> {
  mermaidModulePromise ??= import("mermaid").then((mod) => {
    const instance = mod.default;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    instance.initialize({ startOnLoad: false, theme: prefersDark ? "dark" : "default" });
    return instance;
  });
  return mermaidModulePromise;
}

/** Renders one ```mermaid fenced block as an SVG diagram. The SVG comes
 * from Mermaid's own renderer (a constrained diagram DSL, not arbitrary
 * pasted HTML) — the one deliberate, scoped use of `dangerouslySetInnerHTML`
 * in this app, matching the trust level already extended to override
 * reasons and comments (notes authorship is editor+ role only). */
function MermaidDiagram({ code }: { code: string }): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then((mermaid) => mermaid.render(idRef.current, code))
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to render diagram");
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) return <pre className="endpoint-notes__mermaid-error">{error}</pre>;
  if (!svg) return <p className="muted">Rendering diagram…</p>;
  // eslint-disable-next-line react/no-danger
  return <div className="endpoint-notes__mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const MARKDOWN_COMPONENTS: Components = {
  pre(props) {
    const child = props.children as { props?: { className?: string } } | undefined;
    const childClassName = child?.props?.className ?? "";
    if (/language-mermaid/.test(childClassName)) {
      return <>{props.children}</>;
    }
    return <pre {...props} />;
  },
  code(props) {
    const { className, children } = props;
    const match = /language-(\w+)/.exec(className ?? "");
    if (match?.[1] === "mermaid") {
      return <MermaidDiagram code={String(children).trim()} />;
    }
    return <code className={className}>{children}</code>;
  },
};

function NotesContent({ source }: { source: string }): JSX.Element {
  return (
    <div className="endpoint-notes__content">
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {source}
      </Markdown>
    </div>
  );
}

export function EndpointNotes({ vayoId, notes, config, canEdit }: EndpointNotesProps): JSX.Element | null {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [savedNotes, setSavedNotes] = useState(notes);
  const [previewWhileEditing, setPreviewWhileEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSavedNotes(notes);
    setDraft(notes ?? "");
    setEditing(false);
    setPreviewWhileEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vayoId]);

  async function handleSave() {
    setSaving(true);
    try {
      await api.postOverride(config, `${vayoId}.notes`, draft, null);
      setSavedNotes(draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <section className="detail-section endpoint-notes">
        <div className="endpoint-notes__header">
          <h3>Notes</h3>
          <button type="button" className="link-button" onClick={() => setPreviewWhileEditing((p) => !p)}>
            {previewWhileEditing ? "Show source" : "Preview"}
          </button>
        </div>
        {previewWhileEditing ? (
          <NotesContent source={draft} />
        ) : (
          <CodeMirror
            value={draft}
            height="220px"
            theme="dark"
            extensions={MARKDOWN_EXTENSIONS}
            basicSetup={{ indentOnInput: false }}
            onChange={setDraft}
          />
        )}
        <div className="endpoint-notes__actions">
          <button type="button" className="button" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="button button--primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </section>
    );
  }

  if (!savedNotes) {
    if (!canEdit) return null;
    return (
      <section className="detail-section endpoint-notes">
        <h3>Notes</h3>
        <p className="muted endpoint-notes__empty">
          No notes yet — explain how this endpoint fits into a larger frontend flow (e.g. what a caller should do with
          its response before calling the next endpoint).
        </p>
        <button type="button" className="button" onClick={() => setEditing(true)}>
          Add notes
        </button>
      </section>
    );
  }

  return (
    <section className="detail-section endpoint-notes">
      <div className="endpoint-notes__header">
        <h3>Notes</h3>
        {canEdit && (
          <button type="button" className="link-button" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      <NotesContent source={savedNotes} />
    </section>
  );
}
