// @vayo/ui — a CodeMirror-backed text field that understands `{{variable}}`
// tokens against the active environment: tokens are colored inline
// (green if resolvable, red if not — Postman's own convention), hovering a
// red token surfaces an "Unresolved Variable" popover with an add-variable
// flow, and typing `{{` opens an autocomplete dropdown of saved variable
// names. A plain CodeMirror instance (not the chip-row approach from the
// previous pass) because inline coloring needs the token's own text to
// change color, which a native <input>/<textarea> simply cannot do.
//
// Two more optional, orthogonal concerns bolt onto the same field rather
// than forking a parallel component: `validity` (a second, non-{{var}}
// check — e.g. Try It Now's URL bar flagging a path that matches no
// captured endpoint) renders a red border + a warning line underneath;
// `suggestions` is a second autocomplete source shown whenever the caret
// isn't inside an open `{{...}}` token, so it can't collide with the
// variable dropdown (e.g. that same URL bar suggesting known endpoints).

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { variableDecorationsExtension, type VariableToken } from "../variable-decorations.js";
import { UnresolvedVariablePopover } from "./UnresolvedVariablePopover.js";

export interface FieldValidity {
  valid: boolean;
  warning: string;
}

export interface FieldSuggestion {
  key: string;
  label: ReactNode;
  onSelect: () => void;
}

interface VariableFieldProps {
  value: string;
  onChange: (value: string) => void;
  variables: Record<string, string>;
  environmentName: string | null;
  onAddVariable: ((name: string, value: string) => Promise<void>) | null;
  multiline?: boolean;
  name?: string;
  placeholder?: string;
  className?: string;
  height?: string;
  type?: string;
  validity?: FieldValidity | null;
  suggestions?: FieldSuggestion[];
}

/** Looks backward from the caret for an unclosed `{{` and returns the
 * partial name typed so far, or null if the caret isn't inside one. */
function openTokenBeforeCaret(value: string, caret: number): { start: number; partial: string } | null {
  const upToCaret = value.slice(0, caret);
  const lastOpen = upToCaret.lastIndexOf("{{");
  if (lastOpen === -1) return null;
  if (upToCaret.indexOf("}}", lastOpen) !== -1) return null;
  const partial = upToCaret.slice(lastOpen + 2);
  if (/[\s{}]/.test(partial)) return null;
  return { start: lastOpen, partial };
}

export function VariableField({
  value,
  onChange,
  variables,
  environmentName,
  onAddVariable,
  multiline,
  name,
  placeholder,
  className,
  height,
  type,
  validity,
  suggestions: externalSuggestions,
}: VariableFieldProps): JSX.Element {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const closeTimeoutRef = useRef<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [caretPos, setCaretPos] = useState(0);
  const [hoverToken, setHoverToken] = useState<{ name: string; rect: DOMRect } | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  }, []);

  const handleInvalidHover = useCallback(
    (token: VariableToken, rect: DOMRect) => {
      cancelClose();
      setHoverToken({ name: token.name, rect });
    },
    [cancelClose],
  );

  const handleInvalidUnhover = useCallback(() => {
    closeTimeoutRef.current = window.setTimeout(() => setHoverToken(null), 200);
  }, []);

  const closeNow = useCallback(() => {
    cancelClose();
    setHoverToken(null);
  }, [cancelClose]);

  const varNames = useMemo(() => Object.keys(variables), [variables]);
  const openToken = openTokenBeforeCaret(value, caretPos);
  const varSuggestions = openToken ? varNames.filter((n) => n.toLowerCase().includes(openToken.partial.toLowerCase())) : [];
  const showVarSuggestions = focused && varSuggestions.length > 0;
  const showExtraSuggestions = focused && !openToken && Boolean(externalSuggestions?.length);

  const extensions = useMemo(() => {
    const ext = [
      variableDecorationsExtension(variables, handleInvalidHover, handleInvalidUnhover),
      EditorView.contentAttributes.of({ spellcheck: "false" }),
    ];
    if (multiline) {
      ext.push(EditorView.lineWrapping);
    } else {
      ext.push(
        keymap.of([{ key: "Enter", run: () => true }]),
        EditorView.domEventHandlers({
          paste: (event, view) => {
            const text = event.clipboardData?.getData("text") ?? "";
            if (!text.includes("\n")) return false;
            event.preventDefault();
            view.dispatch(view.state.replaceSelection(text.replace(/[\r\n]+/g, " ")));
            return true;
          },
        }),
      );
    }
    return ext;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variables, multiline, handleInvalidHover, handleInvalidUnhover]);

  function handleChange(nextValue: string) {
    onChange(nextValue);
  }

  function insertVarSuggestion(varName: string) {
    const view = cmRef.current?.view;
    if (!view || !openToken) return;
    const caret = view.state.selection.main.head;
    const inserted = `{{${varName}}}`;
    view.dispatch({
      changes: { from: openToken.start, to: caret, insert: inserted },
      selection: { anchor: openToken.start + inserted.length },
    });
    view.focus();
  }

  if (type === "password") {
    // Masking and inline token coloring are fundamentally incompatible —
    // if the text is dotted out you can't see (or need) the highlighting.
    return (
      <input
        name={name}
        className={className}
        type="password"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className={`variable-field ${validity && !validity.valid ? "variable-field--invalid" : ""}`}>
      <CodeMirror
        ref={cmRef}
        value={value}
        onChange={handleChange}
        onUpdate={(viewUpdate) => setCaretPos(viewUpdate.state.selection.main.head)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        extensions={extensions}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
          closeBrackets: false,
          bracketMatching: false,
          highlightSelectionMatches: false,
          dropCursor: false,
          allowMultipleSelections: false,
        }}
        placeholder={placeholder}
        height={multiline ? (height ?? "200px") : undefined}
        theme="none"
        className={`variable-field__cm ${className ?? ""}`}
      />

      {showVarSuggestions && (
        <div className="variable-field__suggestions">
          {varSuggestions.map((n) => (
            <button
              key={n}
              type="button"
              className="variable-field__suggestion"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertVarSuggestion(n)}
            >
              <span className="variable-field__suggestion-name">{`{{${n}}}`}</span>
              <span className="variable-field__suggestion-value muted">{variables[n]}</span>
            </button>
          ))}
        </div>
      )}

      {showExtraSuggestions && (
        <div className="variable-field__suggestions">
          {externalSuggestions!.map((s) => (
            <button
              key={s.key}
              type="button"
              className="variable-field__suggestion"
              onMouseDown={(e) => e.preventDefault()}
              onClick={s.onSelect}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {validity && !validity.valid && <p className="variable-field__warning">{validity.warning}</p>}

      {hoverToken && (
        <UnresolvedVariablePopover
          name={hoverToken.name}
          anchorRect={hoverToken.rect}
          environmentName={environmentName}
          onAddVariable={
            onAddVariable
              ? async (varName, varValue) => {
                  await onAddVariable(varName, varValue);
                  closeNow();
                }
              : null
          }
          onMouseEnter={cancelClose}
          onMouseLeave={handleInvalidUnhover}
        />
      )}
    </div>
  );
}
