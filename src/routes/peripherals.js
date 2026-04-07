// src/routes/peripherals.js — CRUD des périphériques (Imprimantes, TPE, Afficheurs)
import { Router } from "express";
import { body, param, validationResult } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const router = Router();

// Toutes les opérations nécessitent d'être authentifié
router.use(authenticate);

/**
 * GET/peripherals
 * Liste tous les périphériques de l'établissement
 */
router.get("/", async (req, res, next) => {
  try {
    const peripherals = await prisma.peripheral.findMany({
      where: { establishmentId: req.establishmentId },
      orderBy: { createdAt: "asc" },
    });
    res.json(peripherals);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /peripherals
 * Ajouter un nouveau périphérique (Manager uniquement)
 */
router.post("/",
  requireManager,
  body("name").notEmpty().trim().withMessage("Le nom est requis"),
  body("type").isIn(["PRINTER", "TPE", "DISPLAY", "SCANNER", "SCALE"]).withMessage("Type invalide"),
  body("driver").optional().isString(),
  body("connectionType").optional().isString(),
  body("params").optional().isObject(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Données invalides", details: errors.array() });
      }

      const peripheral = await prisma.peripheral.create({
        data: {
          ...req.body,
          establishmentId: req.establishmentId,
        },
      });

      res.status(201).json(peripheral);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /peripherals/:id
 * Modifier un périphérique
 */
router.put("/:id",
  requireManager,
  param("id").isUUID(),
  async (req, res, next) => {
    try {
      const exists = await prisma.peripheral.findFirst({
        where: { id: req.params.id, establishmentId: req.establishmentId },
      });
      if (!exists) throw new AppError("Périphérique introuvable", 404);

      const peripheral = await prisma.peripheral.update({
        where: { id: req.params.id },
        data: req.body,
      });

      res.json(peripheral);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /peripherals/:id
 * Supprimer un périphérique (Soft delete via active: false)
 */
router.delete("/:id",
  requireManager,
  param("id").isUUID(),
  async (req, res, next) => {
    try {
      const exists = await prisma.peripheral.findFirst({
        where: { id: req.params.id, establishmentId: req.establishmentId },
      });
      if (!exists) throw new AppError("Périphérique introuvable", 404);

      // On peut faire un vrai delete ou un soft delete. 
      // Pour les périphériques, un vrai delete est acceptable si pas de liens transactionnels.
      await prisma.peripheral.delete({
        where: { id: req.params.id },
      });

      res.json({ message: "Périphérique supprimé" });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
