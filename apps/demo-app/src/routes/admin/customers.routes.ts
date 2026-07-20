import express, { type Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { getCustomerById, listCustomers } from "../../services/customerService.js";

const router: Router = express.Router();

router.get("/", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  res.json(listCustomers().map(({ id, name, email, status }) => ({ id, name, email, status })));
});

router.get("/:id", requireAuth, requireRole("admin", "super_admin"), (req, res) => {
  const customer = getCustomerById(req.params.id!);
  if (!customer) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const { id, name, email, status } = customer;
  res.json({ id, name, email, status });
});

export default router;
