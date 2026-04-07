// src/routes/tva.js — Taux de TVA
import { Router } from "express";
import { body, validationResult } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const router = Router();
router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    const rates = await prisma.tvaRate.findMany({
      where: { establishmentId: req.establishmentId },
      include: { _count: { select: { products: true } } },
      orderBy: { rate: "asc" },
    });
    res.json(rates);
  } catch (err) { next(err); }
});

router.post("/", requireManager, body("rate").isFloat({ min: 0, max: 100 }), body("label").notEmpty(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new AppError("Données invalides", 400);
    const rate = await prisma.tvaRate.create({ data: { ...req.body, establishmentId: req.establishmentId } });
    res.status(201).json(rate);
  } catch (err) { next(err); }
});

router.put("/:id", requireManager, async (req, res, next) => {
  try {
    const rate = await prisma.tvaRate.update({ where: { id: req.params.id }, data: req.body });
    res.json(rate);
  } catch (err) { next(err); }
});

export default router;
