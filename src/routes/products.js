// src/routes/products.js — CRUD produits
import { Router } from "express";
import { body, param, validationResult } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const router = Router();
router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    const { categoryId, active = "true", q } = req.query;
    const where = {
      establishmentId: req.establishmentId,
      ...(categoryId ? { categoryId } : {}),
      ...(active !== "all" ? { active: active === "true" } : {}),
      ...(q ? {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
        ],
      } : {}),
    };

    const products = await prisma.product.findMany({
      where,
      include: { category: true, tvaRate: true },
      orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }],
    });
    res.json(products);
  } catch (err) { next(err); }
});

router.post("/",
  requireManager,
  body("name").notEmpty().trim(),
  body("description").optional().trim(),
  body("img").optional().custom((value) => {
    if (!value || typeof value !== 'string') return true;
    if (value.startsWith('data:image/') || /^https?:\/\//i.test(value)) return true;
    throw new Error("URL d'image invalide");
  }),
  body("price").isFloat({ min: 0.01 }),
  body("categoryId").isString().notEmpty(),
  body("tvaRateId").isString().notEmpty(),
  body("trEligible").optional().isBoolean(),
  body("barcode").optional().trim(),
  body("stockEnabled").optional().isBoolean(),
  body("stockQty").optional().isFloat(),
  body("stockAlert").optional().isFloat(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Données invalides", details: errors.array() });

      const product = await prisma.product.create({
        data: { ...req.body, establishmentId: req.establishmentId },
        include: { category: true, tvaRate: true },
      });
      res.status(201).json(product);
    } catch (err) { next(err); }
});

router.put("/:id", requireManager, async (req, res, next) => {
  try {
    const exists = await prisma.product.findFirst({ where: { id: req.params.id, establishmentId: req.establishmentId } });
    if (!exists) throw new AppError("Produit introuvable", 404);

    const updates = { ...req.body };

    if (updates.img && typeof updates.img === 'string' && !updates.img.startsWith('data:image/') && !/^https?:\/\//i.test(updates.img)) {
      throw new AppError("URL d'image invalide", 400);
    }

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: updates,
      include: { category: true, tvaRate: true }
    });
    res.json(product);
  } catch (err) { next(err); }
});

router.delete("/:id", requireManager, param("id").isUUID(), async (req, res, next) => {
  try {
    const exists = await prisma.product.findFirst({ where: { id: req.params.id, establishmentId: req.establishmentId } });
    if (!exists) throw new AppError("Produit introuvable", 404);
    // Soft delete (NF525 — on ne supprime pas les données)
    await prisma.product.update({ where: { id: req.params.id }, data: { active: false } });
    res.json({ message: "Produit désactivé" });
  } catch (err) { next(err); }
});

// ─── ACCOMPAGNEMENTS / SUPPLÉMENTS / SUGGESTIONS ────────────────

// GET tous les accompagnements d'un produit (optionnel: ?type=ACCOMPANIMENT|SUPPLEMENT|SUGGESTION)
router.get("/:id/accompaniments", authenticate, async (req, res, next) => {
  try {
    const where = { productId: req.params.id };
    if (req.query.type) where.type = req.query.type;
    const items = await prisma.productAccompaniment.findMany({
      where,
      include: {
        accompaniment: { select: { id: true, name: true, emoji: true, price: true, img: true, category: { select: { label: true } } } },
      },
      orderBy: [{ type: "asc" }, { sortOrder: "asc" }],
    });
    res.json(items);
  } catch (err) { next(err); }
});

// POST ajouter un accompagnement/supplément/suggestion
router.post("/:id/accompaniments",
  requireManager,
  body("accompanimentId").isString().notEmpty(),
  body("type").optional().isIn(["ACCOMPANIMENT", "SUPPLEMENT", "SUGGESTION"]),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);

      const exists = await prisma.product.findFirst({ where: { id: req.params.id, establishmentId: req.establishmentId } });
      if (!exists) throw new AppError("Produit introuvable", 404);

      const type = req.body.type || "ACCOMPANIMENT";
      const count = await prisma.productAccompaniment.count({ where: { productId: req.params.id, type } });

      const item = await prisma.productAccompaniment.create({
        data: {
          productId:       req.params.id,
          accompanimentId: req.body.accompanimentId,
          type,
          label:           req.body.label || null,
          priceExtra:      ["SUPPLEMENT", "SUGGESTION"].includes(type) ? parseFloat(req.body.priceExtra || 0) : 0,
          required:        req.body.required || false,
          sortOrder:       count,
        },
        include: {
          accompaniment: { select: { id: true, name: true, emoji: true, price: true, img: true } },
        },
      });
      res.status(201).json(item);
    } catch (err) { next(err); }
});

// PUT modifier le label/priceExtra d'un accompagnement
router.put("/:id/accompaniments/:accompId", requireManager, async (req, res, next) => {
  try {
    const item = await prisma.productAccompaniment.update({
      where: { id: req.params.accompId },
      data: {
        label:      req.body.label ?? undefined,
        priceExtra: req.body.priceExtra !== undefined ? parseFloat(req.body.priceExtra) : undefined,
        required:   req.body.required  !== undefined ? req.body.required : undefined,
      },
      include: {
        accompaniment: { select: { id: true, name: true, emoji: true, price: true, img: true } },
      },
    });
    res.json(item);
  } catch (err) { next(err); }
});

// DELETE supprimer un accompagnement
router.delete("/:id/accompaniments/:accompId", requireManager, async (req, res, next) => {
  try {
    await prisma.productAccompaniment.delete({ where: { id: req.params.accompId } });
    res.json({ message: "Supprimé" });
  } catch (err) { next(err); }
});

export default router;
