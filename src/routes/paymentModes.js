// src/routes/paymentModes.js — Modes de paiement
import { Router } from "express";
import { body } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireManager } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    const modes = await prisma.paymentMode.findMany({
      where: { establishmentId: req.establishmentId },
      orderBy: { sortOrder: "asc" },
    });
    res.json(modes);
  } catch (err) { next(err); }
});

router.post("/", requireManager, body("label").notEmpty(), async (req, res, next) => {
  try {
    const mode = await prisma.paymentMode.create({ data: { ...req.body, establishmentId: req.establishmentId } });
    res.status(201).json(mode);
  } catch (err) { next(err); }
});

router.patch("/:id", requireManager, async (req, res, next) => {
  try {
    const mode = await prisma.paymentMode.update({ where: { id: req.params.id }, data: req.body });
    res.json(mode);
  } catch (err) { next(err); }
});

router.delete("/:id", requireManager, async (req, res, next) => {
  try {
    // Soft delete — on désactive le mode au lieu de le supprimer
    await prisma.paymentMode.update({ where: { id: req.params.id }, data: { active: false } });
    res.json({ message: "Mode de paiement désactivé" });
  } catch (err) { next(err); }
});

export default router;
