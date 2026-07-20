// script-runner.worker.ts assigns onmessage directly onto the Worker global
// scope (`self`), which doesn't exist in plain Node — polyfill it before
// import so the module's top-level `self as unknown as WorkerScope` cast
// has something real to attach to.
import { beforeAll, describe, expect, it } from "vitest";
import type { ScriptRunContext, ScriptRunResponse } from "./script-runner.worker.js";

let onmessage: ((event: MessageEvent<{ script: string; context: ScriptRunContext }>) => void) | null = null;

beforeAll(async () => {
  (globalThis as unknown as { self: unknown }).self = {
    set onmessage(fn: typeof onmessage) {
      onmessage = fn;
    },
    postMessage: () => {},
  };
  await import("./script-runner.worker.js");
});

function run(script: string, context: ScriptRunContext): Promise<ScriptRunResponse> {
  return new Promise((resolve) => {
    (globalThis as unknown as { self: { postMessage: (r: ScriptRunResponse) => void } }).self.postMessage = resolve;
    onmessage!({ data: { script, context } } as MessageEvent<{ script: string; context: ScriptRunContext }>);
  });
}

describe("script-runner.worker — pm.response Postman-compatibility", () => {
  it("exposes pm.response.code as the numeric status, matching real Postman scripts", async () => {
    const result = await run('pm.test("status is 200", () => pm.expect(pm.response.code).to.equal(200));', {
      request: { method: "GET", url: "/x", headers: {}, body: null },
      response: { status: 200, headers: {}, body: null },
      variables: {},
    });
    expect(result.results).toEqual([{ name: "status is 200", passed: true }]);
  });

  it("still exposes pm.response.status (Vayo's own field) for scripts written against it directly", async () => {
    const result = await run('pm.test("status field", () => pm.expect(pm.response.status).to.equal(404));', {
      request: { method: "GET", url: "/x", headers: {}, body: null },
      response: { status: 404, headers: {}, body: null },
      variables: {},
    });
    expect(result.results).toEqual([{ name: "status field", passed: true }]);
  });

  it("handles a null response (pre-request script, before any request was sent) without throwing", async () => {
    const result = await run('pm.test("no response yet", () => pm.expect(pm.response).to.equal(null));', {
      request: { method: "GET", url: "/x", headers: {}, body: null },
      response: null,
      variables: {},
    });
    expect(result.results).toEqual([{ name: "no response yet", passed: true }]);
  });
});
