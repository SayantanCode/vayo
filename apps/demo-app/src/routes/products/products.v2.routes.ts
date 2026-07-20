// Public customer-facing product browsing, v2 — adds `sku` to every
// response (docs/09-roadmap.md M6 done-when: a real, non-placeholder
// version diff). Same underlying catalog as v1.

import express, { type Router } from "express";
import { getProductById, listProducts } from "../../services/productService.js";

const router: Router = express.Router();

router.get("/", (req, res) => {
  res.json(listProducts());
});

router.get("/:id", (req, res) => {
  const product = getProductById(req.params.id);
  if (!product) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(product);
});

export default router;
