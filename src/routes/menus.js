// src/routes/menus.js — Menus composés & Formules
import { Router } from "express";
import { body, validationResult } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const router = Router();
router.use(authenticate);

const MENU_INCLUDE = {
  steps: {
    include: {
      choices: {
        include: { product: { select: { id: true, name: true, emoji: true, price: true } } },
        orderBy: { sortOrder: "asc" },
      },
    },
    orderBy: { sortOrder: "asc" },
  },
};

// ─── LISTE ───────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { type } = req.query;
    const menus = await prisma.menu.findMany({
      where: {
        establishmentId: req.establishmentId,
        active: true,
        ...(type ? { menuType: type } : {}),
      },
      include: MENU_INCLUDE,
    });
    res.json(menus);
  } catch (err) { next(err); }
});

// ─── CRÉER ───────────────────────────────────────────────────────
router.post("/",
  requireManager,
  body("name").notEmpty().trim(),
  body("basePrice").isFloat({ min: 0 }),
  body("tva").isFloat({ min: 0 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);

      const { steps = [], ...menuData } = req.body;

      const menu = await prisma.menu.create({
        data: {
          ...menuData,
          basePrice: parseFloat(menuData.basePrice),
          tva:       parseFloat(menuData.tva ?? 10),
          establishmentId: req.establishmentId,
          steps: {
            create: steps.map((s, i) => ({
              label:     s.label,
              icon:      s.icon      || "🍽️",
              required:  s.required  ?? true,
              minChoice: s.minChoice || 1,
              maxChoice: s.maxChoice || 1,
              sortOrder: i,
              choices: {
                create: (s.choices || []).map((c, j) => ({
                  productId:  c.productId,
                  label:      c.label || "",
                  priceExtra: parseFloat(c.priceExtra || 0),
                  sortOrder:  j,
                })),
              },
            })),
          },
        },
        include: MENU_INCLUDE,
      });
      res.status(201).json(menu);
    } catch (err) { next(err); }
});

// ─── MODIFIER (infos de base + étapes) ───────────────────────────
router.put("/:id", requireManager, async (req, res, next) => {
  try {
    const exists = await prisma.menu.findFirst({
      where: { id: req.params.id, establishmentId: req.establishmentId },
    });
    if (!exists) throw new AppError("Menu introuvable", 404);

    const { steps, ...menuData } = req.body;

    // Mettre à jour les infos de base
    await prisma.menu.update({
      where: { id: req.params.id },
      data: {
        ...menuData,
        ...(menuData.basePrice !== undefined ? { basePrice: parseFloat(menuData.basePrice) } : {}),
        ...(menuData.tva       !== undefined ? { tva:       parseFloat(menuData.tva)       } : {}),
      },
    });

    // Si des étapes sont fournies, supprimer les anciennes et recréer (cascade supprime les choix)
    if (Array.isArray(steps)) {
      await prisma.menuStep.deleteMany({ where: { menuId: req.params.id } });
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        await prisma.menuStep.create({
          data: {
            menuId:    req.params.id,
            label:     s.label,
            icon:      s.icon      || "🍽️",
            required:  s.required  ?? true,
            minChoice: s.minChoice || 1,
            maxChoice: s.maxChoice || 1,
            sortOrder: i,
            choices: {
              create: (s.choices || []).map((c, j) => ({
                productId:  c.productId || c.product?.id,
                label:      c.label || "",
                priceExtra: parseFloat(c.priceExtra || 0),
                sortOrder:  j,
              })).filter(c => c.productId),
            },
          },
        });
      }
    }

    const menu = await prisma.menu.findUnique({
      where: { id: req.params.id },
      include: MENU_INCLUDE,
    });
    res.json(menu);
  } catch (err) { next(err); }
});

// ─── SUPPRIMER ───────────────────────────────────────────────────
router.delete("/:id", requireManager, async (req, res, next) => {
  try {
    const exists = await prisma.menu.findFirst({
      where: { id: req.params.id, establishmentId: req.establishmentId },
    });
    if (!exists) throw new AppError("Menu introuvable", 404);

    await prisma.menu.update({
      where: { id: req.params.id },
      data: { active: false },
    });
    res.json({ message: "Menu désactivé" });
  } catch (err) { next(err); }
});

// ─── GESTION DES ÉTAPES ──────────────────────────────────────────

// Ajouter une étape
router.post("/:id/steps", requireManager, async (req, res, next) => {
  try {
    const exists = await prisma.menu.findFirst({
      where: { id: req.params.id, establishmentId: req.establishmentId },
    });
    if (!exists) throw new AppError("Menu introuvable", 404);

    const count = await prisma.menuStep.count({ where: { menuId: req.params.id } });
    const step = await prisma.menuStep.create({
      data: {
        menuId:    req.params.id,
        label:     req.body.label || "Nouvelle étape",
        icon:      req.body.icon      || "🍽️",
        required:  req.body.required  ?? true,
        minChoice: req.body.minChoice || 1,
        maxChoice: req.body.maxChoice || 1,
        sortOrder: count,
      },
      include: { choices: { include: { product: { select: { id: true, name: true, emoji: true, price: true } } } } },
    });
    res.status(201).json(step);
  } catch (err) { next(err); }
});

// Modifier une étape
router.put("/:id/steps/:stepId", requireManager, async (req, res, next) => {
  try {
    const step = await prisma.menuStep.update({
      where: { id: req.params.stepId },
      data: {
        label:     req.body.label,
        icon:      req.body.icon,
        required:  req.body.required,
        minChoice: req.body.minChoice,
        maxChoice: req.body.maxChoice,
      },
      include: { choices: { include: { product: { select: { id: true, name: true, emoji: true, price: true } } } } },
    });
    res.json(step);
  } catch (err) { next(err); }
});

// Supprimer une étape
router.delete("/:id/steps/:stepId", requireManager, async (req, res, next) => {
  try {
    await prisma.menuStep.delete({ where: { id: req.params.stepId } });
    res.json({ message: "Étape supprimée" });
  } catch (err) { next(err); }
});

// ─── GESTION DES CHOIX ───────────────────────────────────────────

// Ajouter un choix à une étape
router.post("/:id/steps/:stepId/choices", requireManager, async (req, res, next) => {
  try {
    const count = await prisma.menuChoice.count({ where: { stepId: req.params.stepId } });
    const choice = await prisma.menuChoice.create({
      data: {
        stepId:     req.params.stepId,
        productId:  req.body.productId,
        label:      req.body.label || "",
        priceExtra: parseFloat(req.body.priceExtra || 0),
        sortOrder:  count,
      },
      include: { product: { select: { id: true, name: true, emoji: true, price: true } } },
    });
    res.status(201).json(choice);
  } catch (err) { next(err); }
});

// Supprimer un choix
router.delete("/:id/steps/:stepId/choices/:choiceId", requireManager, async (req, res, next) => {
  try {
    await prisma.menuChoice.delete({ where: { id: req.params.choiceId } });
    res.json({ message: "Choix supprimé" });
  } catch (err) { next(err); }
});

export default router;
