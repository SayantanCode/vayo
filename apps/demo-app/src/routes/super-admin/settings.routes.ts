import express, { type Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/roles.js";

const router: Router = express.Router();

let settings = { maintenanceMode: false, supportEmail: "support@shop.internal" };

router.get("/", requireAuth, requireRole("super_admin"), (req, res) => {
  res.json(settings);
});

router.patch("/", requireAuth, requireRole("super_admin"), (req, res) => {
  settings = { ...settings, ...(req.body ?? {}) };
  res.json(settings);
});

export default router;
