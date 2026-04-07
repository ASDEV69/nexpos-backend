// src/routes/reservations.js — Routes API Réservations
import { Router } from "express";
import { body, param, query, validationResult } from "express-validator";
import { prisma }       from "../utils/prisma.js";
import { authenticate, requireCashier, requireManager } from "../middleware/auth.js";
import { AppError }     from "../middleware/errorHandler.js";
import { logger }       from "../utils/logger.js";
import {
  getAvailableSlots, createReservation,
  confirmReservation, cancelReservation,
  sendReminders,
} from "../services/reservationService.js";

const router = Router();

// ── Routes publiques (widget embarqué) ──────────────────────────

// Disponibilités — public
router.get("/public/:establishmentId/slots",
  param("establishmentId").isUUID(),
  query("date").isISO8601(),
  query("covers").isInt({ min: 1, max: 30 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Paramètres invalides", 400);
      const result = await getAvailableSlots(
        req.params.establishmentId,
        req.query.date,
        parseInt(req.query.covers),
        parseInt(req.query.duration || "90")
      );
      res.json(result);
    } catch (err) { next(err); }
});

// Créer une réservation depuis le widget — public
router.post("/public/:establishmentId",
  param("establishmentId").isUUID(),
  body("firstName").notEmpty().trim(),
  body("lastName").notEmpty().trim(),
  body("phone").notEmpty().trim(),
  body("email").optional().isEmail().normalizeEmail(),
  body("covers").isInt({ min: 1, max: 30 }),
  body("date").isISO8601(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);
      const r = await createReservation({
        ...req.body,
        establishmentId: req.params.establishmentId,
        source: req.body.source || "online",
      });
      res.status(201).json({
        id: r.id, status: r.status, firstName: r.firstName,
        covers: r.covers, date: r.date, table: r.table?.label,
        message: r.status === "CONFIRMED"
          ? "Réservation confirmée ! Vous allez recevoir un SMS de confirmation."
          : "Réservation reçue, elle sera confirmée sous peu.",
      });
    } catch (err) {
      if (err.message.includes("indisponible")) return next(new AppError(err.message, 409));
      next(err);
    }
});

// Infos établissement pour le widget
router.get("/public/:establishmentId/info",
  param("establishmentId").isUUID(),
  async (req, res, next) => {
    try {
      const estab = await prisma.establishment.findUnique({
        where:  { id: req.params.establishmentId },
        select: { name: true, address: true, zipCode: true, city: true, phone: true, logo: true },
      });
      if (!estab) throw new AppError("Établissement introuvable", 404);
      // ReservationConfig may not exist yet, handle gracefully
      let config = null;
      try {
        config = await prisma.reservationConfig.findUnique({
          where:  { establishmentId: req.params.establishmentId },
          select: { acceptReservations: true, maxAdvanceDays: true, schedule: true, defaultDuration: true },
        });
      } catch { /* model may not exist yet */ }
      res.json({ establishment: estab, config });
    } catch (err) { next(err); }
});

// ── Routes authentifiées (back-office) ──────────────────────────
router.use(authenticate);

// Planning du jour / semaine
router.get("/", requireCashier, async (req, res, next) => {
  try {
    const { date, view = "day", status } = req.query;
    const base  = date ? new Date(date) : new Date();
    let start, end;

    if (view === "week") {
      const dow   = base.getDay();
      start = new Date(base); start.setDate(base.getDate() - dow + 1); start.setHours(0,0,0,0);
      end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23,59,59,999);
    } else {
      start = new Date(base); start.setHours(0,0,0,0);
      end   = new Date(base); end.setHours(23,59,59,999);
    }

    const where = {
      establishmentId: req.establishmentId,
      date: { gte: start, lte: end },
      ...(status ? { status } : {}),
    };

    const [reservations, counts] = await prisma.$transaction([
      prisma.reservation.findMany({
        where,
        orderBy: { date: "asc" },
        include: { table: { select: { label: true, section: true } } },
      }),
      prisma.reservation.groupBy({
        by: ["status"],
        where: { establishmentId: req.establishmentId, date: { gte: start, lte: end } },
        _count: true,
        _sum: { covers: true },
      }),
    ]);

    const stats = counts.reduce((acc, c) => {
      acc[c.status] = { count: c._count, covers: c._sum.covers };
      return acc;
    }, {});

    const config = await prisma.reservationConfig.findUnique({ where: { establishmentId: req.establishmentId } });

    res.json({ reservations, stats, period: { start, end }, config });

  } catch (err) { next(err); }
});

// ── Configuration ───────────────────────────────────────────────

// Mettre à jour la configuration
router.put("/config", requireManager, async (req, res, next) => {
  try {
    const { id, establishmentId, createdAt, updatedAt, ...data } = req.body;
    const config = await prisma.reservationConfig.upsert({
      where:  { establishmentId: req.establishmentId },
      update: data,
      create: { ...data, establishmentId: req.establishmentId },
    });
    res.json(config);
  } catch (err) { next(err); }
});

// ── Détail & Actions ────────────────────────────────────────────

// Détail
router.get("/:id", requireCashier, param("id").isUUID(), async (req, res, next) => {
  try {
    const r = await prisma.reservation.findFirst({
      where: { id: req.params.id, establishmentId: req.establishmentId },
      include: { table: true, customer: { select: { id:true, firstName:true, loyaltyLevel:true, loyaltyPoints:true } } },
    });
    if (!r) throw new AppError("Réservation introuvable", 404);
    res.json(r);
  } catch (err) { next(err); }
});

// Créer depuis la caisse
router.post("/", requireCashier, async (req, res, next) => {
  try {
    const r = await createReservation({
      ...req.body,
      establishmentId: req.establishmentId,
      source: "cashier",
    });
    req.io?.to(req.establishmentId).emit("reservation:new", r);
    res.status(201).json(r);
  } catch (err) {
    if (err.message.includes("indisponible")) return next(new AppError(err.message, 409));
    next(err);
  }
});

// Confirmer
router.post("/:id/confirm", requireCashier, async (req, res, next) => {
  try {
    const r = await confirmReservation(req.params.id, req.user.id);
    req.io?.to(req.establishmentId).emit("reservation:updated", r);
    res.json(r);
  } catch (err) { next(err); }
});

// Installer (client assis)
router.post("/:id/seat", requireCashier, async (req, res, next) => {
  try {
    const r = await prisma.reservation.update({
      where: { id: req.params.id },
      data:  { status: "SEATED" },
    });
    if (r.tableId) {
      await prisma.table.update({ where: { id: r.tableId }, data: { status: "OCCUPIED" } });
    }
    req.io?.to(req.establishmentId).emit("reservation:seated", { id: r.id, tableId: r.tableId });
    res.json(r);
  } catch (err) { next(err); }
});

// Annuler
router.post("/:id/cancel", requireCashier,
  body("reason").optional().isString(),
  async (req, res, next) => {
    try {
      const r = await cancelReservation(req.params.id, req.body.reason, false);
      req.io?.to(req.establishmentId).emit("reservation:cancelled", { id: r.id });
      res.json(r);
    } catch (err) { next(err); }
});

// No-show
router.post("/:id/no-show", requireCashier, async (req, res, next) => {
  try {
    const r = await prisma.reservation.update({
      where: { id: req.params.id },
      data:  { status: "NO_SHOW" },
    });
    logger.warn(`[Reservations] No-show: ${r.firstName} ${r.lastName}`);
    res.json(r);
  } catch (err) { next(err); }
});


// Envoyer les rappels manuellement


// Envoyer les rappels manuellement
router.post("/reminders/send", requireManager, async (req, res, next) => {
  try {
    const result = await sendReminders(parseInt(req.body.hoursAhead || "24"));
    res.json(result);
  } catch (err) { next(err); }
});

export default router;
