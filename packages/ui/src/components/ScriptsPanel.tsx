// @vayo/ui — Try It Now's "Scripts" sub-tab: pre-request/test script
// editors backing the sandboxed run wired into TryItNowTab's send().

import { useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";

interface ScriptsPanelProps {
  preRequestScript: string;
  testScript: string;
  onPreRequestScriptChange: (value: string) => void;
  onTestScriptChange: (value: string) => void;
  onSave: () => void;
  canEdit: boolean;
}

const JS_EXTENSIONS = [javascript()];

export function ScriptsPanel({
  preRequestScript,
  testScript,
  onPreRequestScriptChange,
  onTestScriptChange,
  onSave,
  canEdit,
}: ScriptsPanelProps): JSX.Element {
  const [saved, setSaved] = useState(false);

  function handleSave() {
    onSave();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="scripts-panel">
      <div className="scripts-panel__editor">
        <h3>Pre-request Script</h3>
        <p className="muted">Runs before the request is sent. Use <code>pm.environment.set(key, value)</code> to inject variables.</p>
        <CodeMirror
          value={preRequestScript}
          height="160px"
          theme="dark"
          extensions={JS_EXTENSIONS}
          editable={canEdit}
          onChange={onPreRequestScriptChange}
        />
      </div>

      <div className="scripts-panel__editor">
        <h3>Test Script</h3>
        <p className="muted">
          Runs after the response arrives. Use <code>pm.test(name, fn)</code> and <code>pm.expect(...)</code>.
        </p>
        <CodeMirror
          value={testScript}
          height="160px"
          theme="dark"
          extensions={JS_EXTENSIONS}
          editable={canEdit}
          onChange={onTestScriptChange}
        />
      </div>

      {canEdit && (
        <button type="button" className="button button--primary scripts-panel__save" onClick={handleSave}>
          {saved ? "Saved" : "Save Scripts"}
        </button>
      )}
    </div>
  );
}
