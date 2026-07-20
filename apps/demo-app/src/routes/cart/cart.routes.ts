import express, { type Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { validateBody } from "../../middleware/validate.js";
import { addCartItem, getCart, removeCartItem, updateCartItem } from "../../services/cartService.js";

const router: Router = express.Router();

// Demo-only: cart/order data is keyed by a single fixed customer regardless
// of who's logged in — request/response SHAPE is what matters for Vayo to
// document here, not building a real multi-tenant session system.
const DEMO_CUSTOMER_ID = "cus_1";

const AddCartItemSchema = z.object({
  productId: z.string().describe("The product being added to the cart"),
  quantity: z.number().int().min(1).describe("How many units to add"),
});

router.get("/", requireAuth, requireRole("customer"), (req, res) => {
  res.json(getCart(DEMO_CUSTOMER_ID));
});

router.post("/items", requireAuth, requireRole("customer"), validateBody(AddCartItemSchema), (req, res) => {
  const { productId, quantity } = req.body;
  res.status(201).json(addCartItem(DEMO_CUSTOMER_ID, productId, quantity));
});

router.patch("/items/:itemId", requireAuth, requireRole("customer"), (req, res) => {
  const { quantity } = req.body ?? {};
  const item = updateCartItem(DEMO_CUSTOMER_ID, req.params.itemId!, quantity);
  if (!item) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(item);
});

router.delete("/items/:itemId", requireAuth, requireRole("customer"), (req, res) => {
  removeCartItem(DEMO_CUSTOMER_ID, req.params.itemId!);
  res.status(204).send();
});

export default router;
