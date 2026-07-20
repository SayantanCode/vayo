import express, { type Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { findAdminByEmail } from "../../services/adminService.js";
import { createCustomer, findCustomerByEmail } from "../../services/customerService.js";

const router: Router = express.Router();

router.post("/register", (req, res) => {
  const { name, email, password } = req.body ?? {};
  const customer = createCustomer({ name, email, password });
  res.status(201).json({ id: customer.id, name: customer.name, email: customer.email, role: customer.role });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body ?? {};
  const account = findCustomerByEmail(email) ?? findAdminByEmail(email);
  if (!account || account.password !== password) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  res.json({ token: account.role, user: { id: account.id, name: account.name, email: account.email, role: account.role } });
});

router.post("/logout", requireAuth, (req, res) => {
  res.status(204).send();
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ role: req.user?.role });
});

export default router;
