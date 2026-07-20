// apps/demo-app/src/middleware/scope.ts — stand-in scope-check middleware,
// named + shaped so the AST static pass's scope-check pattern matching
// (docs/04-capture-engine.md §3a) can find calls like
// requireScope("products:write") and extract the literal.

import type { RequestHandler } from "express";

export function requireScope(_scope: string): RequestHandler {
  return (_req, _res, next) => next();
}
