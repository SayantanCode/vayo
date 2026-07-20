import express, { type Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { requireScope } from "../../middleware/scope.js";
import { createOrder, getOrderById, listOrdersForCustomer } from "../../services/orderService.js";

const router: Router = express.Router();
const DEMO_CUSTOMER_ID = "cus_1";

router.get("/", requireAuth, requireRole("customer"), (req, res) => {
  res.json(listOrdersForCustomer(DEMO_CUSTOMER_ID));
});

router.get("/:id", requireAuth, requireRole("customer"), (req, res) => {
  const order = getOrderById(req.params.id!);
  if (!order) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(order);
});

router.post("/", requireAuth, requireRole("customer"), requireScope("orders:create"), (req, res) => {
  const { items, total } = req.body ?? {};
  res.status(201).json(createOrder(DEMO_CUSTOMER_ID, items, total));
});

export default router;
