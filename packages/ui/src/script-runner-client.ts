// @vayo/ui — main-thread side of the sandboxed script runner. Spawns a
// fresh Web Worker per run (via Vite's native `new Worker(new URL(...))`
// pattern) and terminates it either on completion or on timeout — a
// worker that never posts back (e.g. an accidental infinite loop in the
// executed script) can't hang the app.

import type { ScriptRunContext, ScriptRunResponse, ScriptTestResult } from "./script-runner.worker.js";

export type { ScriptRunContext, ScriptTestResult };

const DEFAULT_TIMEOUT_MS = 5000;

export function runScriptInWorker(
  script: string,
  context: ScriptRunContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ScriptRunResponse> {
  if (!script.trim()) {
    return Promise.resolve({ results: [], variables: context.variables });
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./script-runner.worker.ts", import.meta.url), { type: "module" });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("Script timed out"));
    }, timeoutMs);

    worker.onmessage = (event: MessageEvent<ScriptRunResponse>) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };

    worker.onerror = (event: ErrorEvent) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || "Script execution failed"));
    };

    worker.postMessage({ script, context });
  });
}
