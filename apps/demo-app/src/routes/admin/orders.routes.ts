import express, { type Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { requireScope } from "../../middleware/scope.js";
import { getOrderById, listAllOrders, updateOrderStatus } from "../../services/orderService.js";

const router: Router = express.Router();

router.get("/", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  res.json(listAllOrders());
});

router.get("/:id", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const order = getOrderById(req.params.id!);
  if (!order) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(order);
});

router.patch("/:id/status", requireAuth, requireRole("admin", "super_admin"), requireScope("orders:manage"), (req, res) => {
  const { status } = req.body ?? {};
  const order = updateOrderStatus(req.params.id!, status);
  if (!order) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(order);
});

export default router;
