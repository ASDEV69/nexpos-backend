// src/routes/establishments.js — Gestion des paramètres de l'établissement
import { Router } from "express";
import { body, validationResult } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const router = Router();

// Toutes les routes nécessitent d'être authentifié et au moins MANAGER
router.use(authenticate, requireManager);

/**
 * GET /api/v1/establishments/me
 * Récupère les informations de l'établissement actuel
 */
router.get("/me", async (req, res, next) => {
  try {
    const establishment = await prisma.establishment.findUnique({
      where: { id: req.establishmentId },
      include: {
        peripherals: true,
      }
    });
    
    if (!establishment) throw new AppError("Établissement introuvable", 404);
    
    res.json(establishment);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/establishments/me
 * Met à jour les paramètres de l'établissement
 */
router.put("/me",
  body("name").optional().trim().notEmpty(),
  body("siret").optional().trim().isLength({ min: 14, max: 14 }),
  body("address").optional().trim(),
  body("phone").optional().trim(),
  body("email").optional().isEmail(),
  body("contactFirstName").optional().trim(),
  body("contactLastName").optional().trim(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        throw new AppError("Données invalides : " + errors.array().map(e => e.msg).join(", "), 400);
      }

      const { 
        name, siret, address, zipCode, city, country, 
        phone, email, contactFirstName, contactLastName,
        vatNumber, logo 
      } = req.body;

      const updated = await prisma.establishment.update({
        where: { id: req.establishmentId },
        data: {
          name, siret, address, zipCode, city, country,
          phone, email, contactFirstName, contactLastName,
          vatNumber, logo
        }
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
