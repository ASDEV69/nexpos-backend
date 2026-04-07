// src/routes/closures.js — Clôtures NF525 (Z, mensuel, annuel)
import { Router } from "express";
import { body, param, query, validationResult } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";
import { auditLog } from "../utils/auditLog.js";
import {
  performDailyClosure,
  performMonthlyClosure,
  generateFEC,
  generateAuditReport,
} from "../services/nf525Service.js";

const router = Router();
router.use(authenticate);

// ─── LISTE DES CLÔTURES ───────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { type, year, month } = req.query;
    const where = { establishmentId: req.establishmentId };
    if (type) where.type = type;
    if (year) {
      const start = new Date(parseInt(year), 0, 1);
      const end   = new Date(parseInt(year), 11, 31, 23, 59, 59);
      where.periodStart = { gte: start, lte: end };
    }

    const closures = await prisma.closure.findMany({
      where,
      orderBy: { signedAt: "desc" },
      take: 100,
    });

    res.json(closures);
  } catch (err) { next(err); }
});

// ─── CLÔTURE JOURNALIÈRE (TICKET Z) ─────────────────────────────
router.post("/daily",
  requireManager,
  async (req, res, next) => {
    try {
      const closure = await performDailyClosure(req.establishmentId, req.user.id);

      await auditLog({
        establishmentId: req.establishmentId,
        userId:   req.user.id,
        action:   "CLOSURE_Z",
        entity:   "closure",
        entityId: closure.id,
        after: {
          type: "DAILY",
          ticketCount: closure.ticketCount,
          totalTtc: closure.totalTtc,
          hash: closure.hash,
        },
      });

      req.io?.to(req.establishmentId).emit("closure:daily", { id: closure.id });
      res.status(201).json(closure);
    } catch (err) { next(err); }
});

// ─── CLÔTURE MENSUELLE ─────────────────────────────────────────────
router.post("/monthly",
  requireManager,
  body("year").isInt({ min: 2020, max: 2099 }),
  body("month").isInt({ min: 0, max: 11 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Date invalide", 400);

      const { year, month } = req.body;
      const closure = await performMonthlyClosure(req.establishmentId, year, month, req.user.id);

      await auditLog({
        establishmentId: req.establishmentId,
        userId:   req.user.id,
        action:   "CLOSURE_M",
        entity:   "closure",
        entityId: closure.id,
        after: {
          type: "MONTHLY",
          period: `${month+1}/${year}`,
          totalTtc: closure.totalTtc,
        },
      });

      res.status(201).json(closure);
    } catch (err) { next(err); }
});

// ─── RÉCUPÉRER UNE CLÔTURE ────────────────────────────────────────
router.get("/:id", param("id").isUUID(), async (req, res, next) => {
  try {
    const closure = await prisma.closure.findFirst({
      where: { id: req.params.id, establishmentId: req.establishmentId },
    });
    if (!closure) throw new AppError("Clôture introuvable", 404);
    res.json(closure);
  } catch (err) { next(err); }
});

// ─── EXPORT FEC ────────────────────────────────────────────────────
router.get("/export/fec",
  requireManager,
  query("year").isInt({ min: 2020, max: 2099 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Année invalide", 400);

      const year = parseInt(req.query.year);
      const csv  = await generateFEC(req.establishmentId, year);

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",
        `attachment; filename="FEC_${req.establishmentId}_${year}.txt"`
      );
      res.send("\uFEFF" + csv); // BOM UTF-8 requis par certains logiciels comptables
    } catch (err) { next(err); }
});

// ─── RAPPORT D'AUDIT NF525 ────────────────────────────────────────
router.get("/audit/report",
  requireManager,
  query("startDate").isISO8601(),
  query("endDate").isISO8601(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Dates invalides", 400);

      const report = await generateAuditReport(
        req.establishmentId,
        new Date(req.query.startDate),
        new Date(req.query.endDate)
      );

      res.json(report);
    } catch (err) { next(err); }
});

export default router;
