// Public customer-facing product browsing, v1. See products.v2.routes.ts
// for the versioned counterpart — v2 additionally returns `sku`.

import express, { type Router } from "express";
import { getProductById, listProducts } from "../../services/productService.js";

const router: Router = express.Router();

router.get("/", (req, res) => {
  res.json(listProducts().map(({ id, name, description, price }) => ({ id, name, description, price })));
});

router.get("/:id", (req, res) => {
  const product = getProductById(req.params.id);
  if (!product) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const { id, name, description, price } = product;
  res.json({ id, name, description, price });
});

export default router;
