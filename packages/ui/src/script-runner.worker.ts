// @vayo/ui — the sandboxed script execution environment. Runs entirely
// inside a Web Worker, which is what provides the isolation: a worker has
// no access to `window`, `document`, `localStorage`, cookies, or the page's
// own same-origin fetch — that's a property of the Worker global scope
// itself, not something this file has to enforce. This isolates *accidents*
// (infinite loops, crashes) and blocks DOM/storage access; it is not a
// hardened multi-tenant sandbox (a script author is already a logged-in
// team member typing into their own docs tool — same trust level as writing
// an override reason or a comment).

export interface ScriptRunContext {
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown } | null;
  variables: Record<string, string>;
}

export interface ScriptTestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ScriptRunMessage {
  script: string;
  context: ScriptRunContext;
}

export interface ScriptRunResponse {
  results: ScriptTestResult[];
  variables: Record<string, string>;
}

/** A small, hand-written chai-*like* subset — not bundled chai. Covers the
 * realistic set of assertions a Postman-script author actually writes.
 * `.to`/`.be`/`.have`/`.an` are chainable no-ops (return the same
 * assertion); `.equal`/`.eql`/`.a`/`.include`/`.property` are the terminal
 * checks. Deliberately partial — no `.not`, no deep chain negation. */
class Assertion {
  constructor(private actual: unknown) {}

  get to(): this {
    return this;
  }
  get be(): this {
    return this;
  }
  get have(): this {
    return this;
  }
  get an(): this {
    return this;
  }

  equal(expected: unknown): void {
    if (this.actual !== expected) {
      throw new Error(`expected ${JSON.stringify(this.actual)} to equal ${JSON.stringify(expected)}`);
    }
  }

  eql(expected: unknown): void {
    if (JSON.stringify(this.actual) !== JSON.stringify(expected)) {
      throw new Error(`expected ${JSON.stringify(this.actual)} to deeply equal ${JSON.stringify(expected)}`);
    }
  }

  a(type: string): void {
    const actualType = Array.isArray(this.actual) ? "array" : typeof this.actual;
    if (actualType !== type) {
      throw new Error(`expected ${JSON.stringify(this.actual)} to be a ${type}, got ${actualType}`);
    }
  }

  include(item: unknown): void {
    const actual = this.actual;
    const ok =
      (typeof actual === "string" && typeof item === "string" && actual.includes(item)) ||
      (Array.isArray(actual) && actual.includes(item));
    if (!ok) {
      throw new Error(`expected ${JSON.stringify(actual)} to include ${JSON.stringify(item)}`);
    }
  }

  property(name: string): void {
    if (typeof this.actual !== "object" || this.actual === null || !(name in this.actual)) {
      throw new Error(`expected ${JSON.stringify(this.actual)} to have property '${name}'`);
    }
  }
}

function expect(actual: unknown): Assertion {
  return new Assertion(actual);
}

// @vayo/ui's tsconfig uses the "DOM" lib (for the rest of the app), which
// types the ambient `self` as `Window` — not the `DedicatedWorkerGlobalScope`
// this file actually runs as. Rather than giving this one file its own
// "WebWorker"-lib tsconfig (which conflicts with "DOM" if both are ever
// combined in the same program), the worker's messaging surface is narrowed
// through one explicit cast instead of relying on ambient globals typed for
// the wrong scope.
interface WorkerScope {
  onmessage: ((event: MessageEvent<ScriptRunMessage>) => void) | null;
  postMessage: (message: ScriptRunResponse) => void;
}
const workerScope = self as unknown as WorkerScope;

workerScope.onmessage = (event: MessageEvent<ScriptRunMessage>) => {
  const { script, context } = event.data;
  const results: ScriptTestResult[] = [];
  const variables = { ...context.variables };

  function test(name: string, fn: () => void): void {
    try {
      fn();
      results.push({ name, passed: true });
    } catch (err) {
      results.push({ name, passed: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const pm = {
    test,
    expect,
    request: context.request,
    // Real Postman scripts use `pm.response.code` for the numeric status —
    // `context.response.status` is Vayo's own internal field name (matches
    // `RequestResult.status` everywhere else in the app), so the Postman-
    // compatible alias is added here, at the sandbox boundary, rather than
    // renaming Vayo's own internal shape.
    response: context.response ? { ...context.response, code: context.response.status } : null,
    environment: {
      get: (key: string) => variables[key],
      set: (key: string, value: string) => {
        variables[key] = value;
      },
    },
  };

  try {
    const runner = new Function("pm", script);
    runner(pm);
  } catch (err) {
    results.push({ name: "Script error", passed: false, error: err instanceof Error ? err.message : String(err) });
  }

  const response: ScriptRunResponse = { results, variables };
  workerScope.postMessage(response);
};
