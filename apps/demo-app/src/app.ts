// apps/demo-app/src/app.ts — the plain Express app, with zero Vayo wiring.
// This is what `@vayo/ast`'s static pass imports (docs/04-capture-engine.md
// Step 2 #1: "a bootstrapped instance of the user's app") — express-list-
// endpoints must see only the user's own routes/middleware, never Vayo's
// own capture() middleware. src/index.ts wraps this with capture() + starts
// the real server; this file never calls app.listen() or touches Mongo.
//
// A small multi-role e-commerce API — auth, customer-facing (products/cart/
// orders), admin, and super-admin sections — built with express.Router()
// composition across loaders/middleware/services/routes, the shape a real
// backend actually takes, not one flat file of routes.

import type { Express, RequestHandler } from "express";
import { createExpressApp } from "./loaders/express.js";
import { mountRoutes } from "./loaders/routes.js";

export function createApp(extraMiddleware: RequestHandler[] = []): Express {
  const app = createExpressApp();
  for (const middleware of extraMiddleware) app.use(middleware);
  mountRoutes(app);
  return app;
}
