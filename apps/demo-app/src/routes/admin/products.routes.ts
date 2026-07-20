// Admin product management, v1. See products.v2.routes.ts (also under
// this same routes/admin/ folder — still collapses into the "Admin" group)
// for the v2 create endpoint that requires `sku`.

import express, { type Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { requireScope } from "../../middleware/scope.js";
import { createProduct, listProducts, updateProduct } from "../../services/productService.js";

const router: Router = express.Router();

router.get("/", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  res.json(listProducts());
});

router.post("/", requireAuth, requireRole("admin", "super_admin"), requireScope("products:write"), (req, res) => {
  const { name, description, price } = req.body ?? {};
  res.status(201).json(createProduct({ name, description, price, sku: `SKU-${Date.now()}` }));
});

router.patch("/:id", requireAuth, requireRole("admin", "super_admin"), requireScope("products:write"), (req, res) => {
  const product = updateProduct(req.params.id!, req.body ?? {});
  if (!product) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(product);
});

export default router;
