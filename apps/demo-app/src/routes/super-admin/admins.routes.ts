import express, { type Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";
import { createAdmin, listAdmins, updateAdmin } from "../../services/adminService.js";

const router: Router = express.Router();

router.get("/", requireAuth, requireRole("super_admin"), (req, res) => {
  res.json(listAdmins().map(({ id, name, email, role }) => ({ id, name, email, role })));
});

router.post("/", requireAuth, requireRole("super_admin"), (req, res) => {
  const { name, email, password, role } = req.body ?? {};
  res.status(201).json(createAdmin({ name, email, password, role }));
});

router.patch("/:id", requireAuth, requireRole("super_admin"), (req, res) => {
  const admin = updateAdmin(req.params.id!, req.body ?? {});
  if (!admin) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(admin);
});

export default router;
