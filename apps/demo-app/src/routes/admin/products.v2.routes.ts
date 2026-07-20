// Admin product management, v2 — create now requires a `sku` in the
// payload (docs/09-roadmap.md M6 done-when: a real version diff).

import express, { type Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { requireScope } from "../../middleware/scope.js";
import { createProduct } from "../../services/productService.js";

const router: Router = express.Router();

router.post("/", requireAuth, requireRole("admin", "super_admin"), requireScope("products:write"), (req, res) => {
  const { name, description, price, sku } = req.body ?? {};
  res.status(201).json(createProduct({ name, description, price, sku }));
});

export default router;
