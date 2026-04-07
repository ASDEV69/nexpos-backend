// src/routes/categories.js — CRUD catégories
import { Router } from "express";
import { body, validationResult } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const router = Router();
router.use(authenticate);

router.get("/", async (req, res, next) => {
  try {
    const { type, q, active = "true" } = req.query;
    const where = {
      establishmentId: req.establishmentId,
      ...(active !== "all" ? { active: active === "true" } : {}),
      ...(type ? { type } : {}),
      ...(q ? {
        OR: [
          { label: { contains: q, mode: "insensitive" } },
          { icon: { contains: q, mode: "insensitive" } },
        ],
      } : {}),
    };

    const cats = await prisma.category.findMany({
      where,
      include: { _count: { select: { products: true } } },
      orderBy: [{ type: "asc" }, { sortOrder: "asc" }],
    });
    res.json(cats);
  } catch (err) { next(err); }
});

router.post("/", requireManager,
  body("label").notEmpty(),
  body("img").optional().custom((value) => {
    if (!value) return true;
    if (value.startsWith('data:image/') || /^https?:\/\//i.test(value)) return true;
    throw new Error("URL d'image invalide");
  }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);
      const cat = await prisma.category.create({ data: { ...req.body, establishmentId: req.establishmentId } });
      res.status(201).json(cat);
    } catch (err) { next(err); }
});

router.put("/:id", requireManager, async (req, res, next) => {
  try {
    const exists = await prisma.category.findFirst({ where: { id: req.params.id, establishmentId: req.establishmentId } });
    if (!exists) throw new AppError("Catégorie introuvable", 404);
    const cat = await prisma.category.update({ where: { id: req.params.id }, data: req.body });
    res.json(cat);
  } catch (err) { next(err); }
});

router.delete("/:id", requireManager, async (req, res, next) => {
  try {
    const count = await prisma.product.count({ where: { categoryId: req.params.id, active: true } });
    if (count > 0) throw new AppError(`Impossible — ${count} produit(s) utilisent cette catégorie`, 409);
    await prisma.category.update({ where: { id: req.params.id }, data: { active: false } });
    res.json({ message: "Catégorie supprimée" });
  } catch (err) { next(err); }
});

export default router;
