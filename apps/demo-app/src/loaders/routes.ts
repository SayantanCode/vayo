// apps/demo-app/src/loaders/routes.ts — the ONE place that knows every
// domain router's mount prefix. Each router is a plain express.Router()
// default-exported from its own file under src/routes/<group>/ — the
// folder/mount-path convention @vayo/ast's group-inference already knows
// about (docs/04-capture-engine.md Step 2 #4). Products and Admin-products
// each have a v1 and a v2 router (two separate files, same folder — still
// one auto-inferred group) since that's the one resource actually versioned
// (docs/07-api-versioning.md); everything else only ever existed at v1,
// which is realistic — a version bump doesn't mean every route changed.

import type { Express } from "express";
import authRouter from "../routes/auth/auth.routes.js";
import adminCustomersRouter from "../routes/admin/customers.routes.js";
import adminOrdersRouter from "../routes/admin/orders.routes.js";
import adminProductsRouter from "../routes/admin/products.routes.js";
import adminProductsV2Router from "../routes/admin/products.v2.routes.js";
import cartRouter from "../routes/cart/cart.routes.js";
import ordersRouter from "../routes/orders/orders.routes.js";
import productsRouter from "../routes/products/products.routes.js";
import productsV2Router from "../routes/products/products.v2.routes.js";
import superAdminAdminsRouter from "../routes/super-admin/admins.routes.js";
import superAdminSettingsRouter from "../routes/super-admin/settings.routes.js";

export function mountRoutes(app: Express): void {
  app.use("/api/v1/auth", authRouter);

  app.use("/api/v1/products", productsRouter);
  app.use("/api/v2/products", productsV2Router);

  app.use("/api/v1/cart", cartRouter);
  app.use("/api/v1/orders", ordersRouter);

  app.use("/api/v1/admin/products", adminProductsRouter);
  app.use("/api/v2/admin/products", adminProductsV2Router);
  app.use("/api/v1/admin/orders", adminOrdersRouter);
  app.use("/api/v1/admin/customers", adminCustomersRouter);

  app.use("/api/v1/super-admin/admins", superAdminAdminsRouter);
  app.use("/api/v1/super-admin/settings", superAdminSettingsRouter);
}
