// apps/demo-app/src/loaders/express.ts — the base Express app: JSON body
// parsing plus the dev-only CORS handler that lets @vayo/ui's Try It Now
// tab call this API directly from the browser. No routes mounted here —
// that's loaders/routes.ts's job, kept separate so each loader has exactly
// one responsibility.

import express, { type Express } from "express";

export function createExpressApp(): Express {
  const app = express();
  app.use(express.json());
  // A real API's own CORS policy is that API's choice, not something Vayo
  // can or should bypass on its behalf — this is app-level (not per-route)
  // middleware, so it never appears in express-list-endpoints' per-route
  // middleware chain.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin === "http://localhost:5173") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  return app;
}
