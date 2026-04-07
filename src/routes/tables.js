// src/routes/tables.js — Plan de salle et statuts tables
import { Router } from "express";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { param, body, validationResult } from "express-validator";

const router = Router();
router.use(authenticate);

// GET /tables — Lister toutes les tables avec tickets actifs
router.get("/", async (req, res, next) => {
  try {
    const tables = await prisma.table.findMany({
      where: { establishmentId: req.establishmentId, active: true },
      include: {
        tickets: {
          where: { status: { in: ["OPEN", "SENT", "READY"] } },
          select: { id: true, number: true, covers: true, finalAmount: true, status: true },
          take: 1,
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: [{ section: "asc" }, { label: "asc" }],
    });
    res.json(tables);
  } catch (err) { next(err); }
});

// GET /tables/sections — Lister toutes les salles uniques
router.get("/sections", async (req, res, next) => {
  try {
    const sections = await prisma.table.findMany({
      where: { establishmentId: req.establishmentId, active: true },
      distinct: ["section"],
      select: { section: true },
    });
    const sectionList = sections
      .map(s => s.section || "Salle principale")
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort();
    res.json(sectionList);
  } catch (err) { next(err); }
});

// GET /tables/:id — Récupérer une table
router.get("/:id", param("id").isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const table = await prisma.table.findUnique({
      where: { id: req.params.id },
      include: {
        tickets: {
          where: { status: { in: ["OPEN", "SENT", "READY"] } },
          select: { id: true, number: true, covers: true, finalAmount: true, status: true },
          take: 1,
        },
      },
    });

    if (!table || table.establishmentId !== req.establishmentId) {
      return res.status(404).json({ error: "Table not found" });
    }

    res.json(table);
  } catch (err) { next(err); }
});

// POST /tables — Créer une table
router.post(
  "/",
  requireManager,
  body("label").notEmpty().trim(),
  body("section").optional().trim(),
  body("covers").isInt({ min: 1, max: 100 }).toInt(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { label, section, covers, posX, posY } = req.body;

      const table = await prisma.table.create({
        data: {
          establishmentId: req.establishmentId,
          label,
          section: section || "Salle principale",
          covers: parseInt(covers),
          posX: posX || 0,
          posY: posY || 0,
          active: true,
        },
      });

      req.io?.to(req.establishmentId).emit("table:created", table);
      res.status(201).json(table);
    } catch (err) { next(err); }
  }
);

// PUT /tables/:id — Modifier une table
router.put(
  "/:id",
  requireManager,
  param("id").isUUID(),
  body("label").optional().notEmpty().trim(),
  body("section").optional().trim(),
  body("covers").optional().isInt({ min: 1, max: 100 }).toInt(),
  body("active").optional().isBoolean(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { label, section, covers, posX, posY, active } = req.body;

      const table = await prisma.table.findUnique({ where: { id: req.params.id } });
      if (!table || table.establishmentId !== req.establishmentId) {
        return res.status(404).json({ error: "Table not found" });
      }

      const updateData = {};
      if (label !== undefined) updateData.label = label;
      if (section !== undefined) updateData.section = section;
      if (covers !== undefined) updateData.covers = covers;
      if (posX !== undefined) updateData.posX = posX;
      if (posY !== undefined) updateData.posY = posY;
      if (active !== undefined) updateData.active = active;

      const updatedTable = await prisma.table.update({
        where: { id: req.params.id },
        data: updateData,
      });

      req.io?.to(req.establishmentId).emit("table:updated", updatedTable);
      res.json(updatedTable);
    } catch (err) { next(err); }
  }
);

// DELETE /tables/:id — Supprimer une table (soft delete)
router.delete("/:id", requireManager, param("id").isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const table = await prisma.table.findUnique({ where: { id: req.params.id } });
    if (!table || table.establishmentId !== req.establishmentId) {
      return res.status(404).json({ error: "Table not found" });
    }

    const deletedTable = await prisma.table.update({
      where: { id: req.params.id },
      data: { active: false },
    });

    req.io?.to(req.establishmentId).emit("table:deleted", { id: deletedTable.id });
    res.json({ message: "Table deleted" });
  } catch (err) { next(err); }
});

// PATCH /tables/:id/status — Changer le statut d'une table
router.patch("/:id/status", param("id").isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { status } = req.body;

    const table = await prisma.table.findUnique({ where: { id: req.params.id } });
    if (!table || table.establishmentId !== req.establishmentId) {
      return res.status(404).json({ error: "Table not found" });
    }

    const updatedTable = await prisma.table.update({
      where: { id: req.params.id },
      data: { status },
    });

    req.io?.to(req.establishmentId).emit("table:updated", updatedTable);
    res.json(updatedTable);
  } catch (err) { next(err); }
});

// PATCH /tables/:id/position — Mettre à jour position (drag & drop)
router.patch(
  "/:id/position",
  requireManager,
  param("id").isUUID(),
  body("posX").isInt(),
  body("posY").isInt(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { posX, posY } = req.body;

      const table = await prisma.table.findUnique({ where: { id: req.params.id } });
      if (!table || table.establishmentId !== req.establishmentId) {
        return res.status(404).json({ error: "Table not found" });
      }

      const updatedTable = await prisma.table.update({
        where: { id: req.params.id },
        data: { posX, posY },
      });

      req.io?.to(req.establishmentId).emit("table:position", updatedTable);
      res.json(updatedTable);
    } catch (err) { next(err); }
  }
);

export default router;
