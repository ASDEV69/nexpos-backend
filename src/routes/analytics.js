// src/routes/analytics.js — Routes API Analytics & KPIs
import { Router } from "express";
import { query, validationResult } from "express-validator";
import { prisma }       from "../utils/prisma.js";
import { authenticate, requireCashier, requireManager } from "../middleware/auth.js";
import { AppError }     from "../middleware/errorHandler.js";
import {
  generateForecasts, getHourlyForecast, generateInsights,
  getUpsellingSuggestions, getCohortAnalysis, getHistoricalData,
} from "../services/forecastService.js";

const router = Router();
router.use(authenticate, requireCashier);

// ── Prévisions de ventes ─────────────────────────────────────────
router.get("/forecasts",
  query("horizon").optional().isInt({ min: 1, max: 90 }),
  async (req, res, next) => {
    try {
      const horizon = parseInt(req.query.horizon || "14");
      const result  = await generateForecasts(req.establishmentId, horizon);
      res.json(result);
    } catch (err) { next(err); }
});

// ── Prévision horaire d'une journée ─────────────────────────────
router.get("/forecasts/hourly",
  query("date").optional().isISO8601(),
  async (req, res, next) => {
    try {
      const date   = req.query.date || new Date().toISOString().slice(0, 10);
      const hourly = await getHourlyForecast(req.establishmentId, date);
      res.json({ date, hourly });
    } catch (err) { next(err); }
});

// ── Insights & recommandations ───────────────────────────────────
router.get("/insights", async (req, res, next) => {
  try {
    const insights = await generateInsights(req.establishmentId);
    res.json(insights);
  } catch (err) { next(err); }
});

// ── Suggestions upselling (kiosk) ───────────────────────────────
router.post("/upselling", async (req, res, next) => {
  try {
    const { currentItems = [] } = req.body;
    const suggestions = await getUpsellingSuggestions(req.establishmentId, currentItems);
    res.json(suggestions);
  } catch (err) { next(err); }
});

// ── Analyse de cohortes ──────────────────────────────────────────
router.get("/cohorts",
  requireManager,
  query("months").optional().isInt({ min: 2, max: 12 }),
  async (req, res, next) => {
    try {
      const months  = parseInt(req.query.months || "6");
      const cohorts = await getCohortAnalysis(req.establishmentId, months);
      res.json(cohorts);
    } catch (err) { next(err); }
});

// ── Données historiques brutes ───────────────────────────────────
router.get("/history",
  query("days").optional().isInt({ min: 7, max: 365 }),
  async (req, res, next) => {
    try {
      const days    = parseInt(req.query.days || "90");
      const history = await getHistoricalData(req.establishmentId, days);
      res.json(history);
    } catch (err) { next(err); }
});

// ── KPIs avancés ────────────────────────────────────────────────
router.get("/kpis", async (req, res, next) => {
  try {
    const eid = req.establishmentId;
    const now = new Date();
    const d30 = new Date(Date.now() - 30 * 86400000);
    const d60 = new Date(Date.now() - 60 * 86400000);

    const [current, previous, topProducts, peakHours] = await prisma.$transaction([
      prisma.ticket.aggregate({
        where:  { establishmentId: eid, status: "PAID", createdAt: { gte: d30 } },
        _sum:   { finalAmount: true },
        _count: true,
        _avg:   { finalAmount: true },
      }),
      prisma.ticket.aggregate({
        where:  { establishmentId: eid, status: "PAID", createdAt: { gte: d60, lt: d30 } },
        _sum:   { finalAmount: true },
        _count: true,
        _avg:   { finalAmount: true },
      }),
      prisma.ticketLine.groupBy({
        by:    ["label"],
        where: { ticket: { establishmentId: eid, status: "PAID", createdAt: { gte: d30 } } },
        _sum:  { qty: true, totalTtc: true },
        _count: true,
        orderBy: { _sum: { totalTtc: "desc" } },
        take:   5,
      }),
      prisma.ticket.findMany({
        where:  { establishmentId: eid, status: "PAID", createdAt: { gte: d30 } },
        select: { createdAt: true, finalAmount: true },
      }),
    ]);

    const pctChange = (cur, prev) => prev > 0 ? ((cur - prev) / prev * 100) : null;

    const curCa   = parseFloat(current._sum.finalAmount  || 0);
    const prevCa  = parseFloat(previous._sum.finalAmount || 0);
    const curTix  = current._count;
    const prevTix = previous._count;
    const curAvg  = parseFloat(current._avg.finalAmount  || 0);
    const prevAvg = parseFloat(previous._avg.finalAmount || 0);

    const heatmap = Array.from({ length: 24 }, (_, h) => ({ hour: h, ca: 0, count: 0 }));
    for (const t of peakHours) {
      const h = new Date(t.createdAt).getHours();
      heatmap[h].ca    += parseFloat(t.finalAmount);
      heatmap[h].count += 1;
    }

    res.json({
      period: "30j",
      ca: {
        current:  Math.round(curCa),
        previous: Math.round(prevCa),
        change:   pctChange(curCa, prevCa)?.toFixed(1),
      },
      tickets: {
        current:  curTix,
        previous: prevTix,
        change:   pctChange(curTix, prevTix)?.toFixed(1),
      },
      avgBasket: {
        current:  Math.round(curAvg * 100) / 100,
        previous: Math.round(prevAvg * 100) / 100,
        change:   pctChange(curAvg, prevAvg)?.toFixed(1),
      },
      topProducts: topProducts.map(p => ({
        label:   p.label,
        qty:     Math.round(parseFloat(p._sum.qty || 0)),
        revenue: Math.round(parseFloat(p._sum.totalTtc || 0)),
        count:   p._count,
      })),
      peakHours: heatmap,
    });
  } catch (err) { next(err); }
});

export default router;
