// @vayo/ui — CodeMirror extension that finds `{{variable}}` tokens in a
// document and colors them inline (green/red) based on whether they
// resolve against the active environment, Postman-style. Valid tokens get
// a native `title` tooltip with the resolved value; invalid tokens report
// clicks back to React (via `onInvalidClick`) so the caller can show an
// "Unresolved Variable" popover with an add-variable flow.

import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

const TOKEN_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

export interface VariableToken {
  from: number;
  to: number;
  name: string;
  valid: boolean;
}

export function findVariableTokens(text: string, variables: Record<string, string>): VariableToken[] {
  const tokens: VariableToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text))) {
    const name = m[1];
    if (name === undefined) continue;
    tokens.push({
      from: m.index,
      to: m.index + m[0].length,
      name,
      valid: Object.prototype.hasOwnProperty.call(variables, name),
    });
  }
  return tokens;
}

function buildDecorations(text: string, variables: Record<string, string>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const token of findVariableTokens(text, variables)) {
    builder.add(
      token.from,
      token.to,
      Decoration.mark({
        class: token.valid ? "cm-vayo-var-valid" : "cm-vayo-var-invalid",
        attributes: token.valid ? { title: variables[token.name] ?? "" } : {},
      }),
    );
  }
  return builder.finish();
}

export function variableDecorationsExtension(
  variables: Record<string, string>,
  onInvalidHover: (token: VariableToken, rect: DOMRect) => void,
  onInvalidUnhover: () => void,
) {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = buildDecorations(view.state.doc.toString(), variables);
        }
        update(update: ViewUpdate) {
          if (update.docChanged) {
            this.decorations = buildDecorations(update.state.doc.toString(), variables);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.domEventHandlers({
      mouseover: (event, view) => {
        const target = event.target as HTMLElement;
        if (!target.classList?.contains("cm-vayo-var-invalid")) return false;
        const pos = view.posAtDOM(target);
        // Half-open interval — matters when two tokens are directly
        // adjacent (no separator between them): posAtDOM(target) returns
        // the position at the *start* of the hovered span, which equals
        // both the previous token's `to` and this token's `from`. An
        // inclusive upper bound would let `.find()` match the wrong
        // (earlier) token in that case.
        const token = findVariableTokens(view.state.doc.toString(), variables).find((t) => pos >= t.from && pos < t.to);
        if (token) onInvalidHover(token, target.getBoundingClientRect());
        return false;
      },
      mouseout: (event) => {
        const target = event.target as HTMLElement;
        if (target.classList?.contains("cm-vayo-var-invalid")) onInvalidUnhover();
        return false;
      },
      mousedown: (event, view) => {
        const target = event.target as HTMLElement;
        if (!target.classList?.contains("cm-vayo-var-invalid")) return false;
        // Keep the caret out of an unresolved token on click — the popover
        // (with its "Add new variable" flow) is the intended interaction,
        // not text editing inside the token itself.
        const pos = view.posAtDOM(target);
        // Half-open interval — matters when two tokens are directly
        // adjacent (no separator between them): posAtDOM(target) returns
        // the position at the *start* of the hovered span, which equals
        // both the previous token's `to` and this token's `from`. An
        // inclusive upper bound would let `.find()` match the wrong
        // (earlier) token in that case.
        const token = findVariableTokens(view.state.doc.toString(), variables).find((t) => pos >= t.from && pos < t.to);
        if (token) onInvalidHover(token, target.getBoundingClientRect());
        return false;
      },
    }),
  ];
}
