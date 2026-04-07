// src/routes/reports.js — Rapports & analytiques
import { Router } from "express";
import { query, validationResult } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireCashier } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const router = Router();
router.use(authenticate, requireCashier);

// ─── DASHBOARD DU JOUR ────────────────────────────────────────────
router.get("/dashboard", async (req, res, next) => {
  try {
    const { date } = req.query;
    const d     = date ? new Date(date) : new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
    const end   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
    const eid   = req.establishmentId;

    const [tickets, closureToday] = await prisma.$transaction([
      prisma.ticket.findMany({
        where: { establishmentId: eid, status: "PAID", createdAt: { gte: start, lte: end } },
        include: {
          lines:    { include: { tvaRateRef: true } },
          payments: { include: { paymentMode: true } },
        },
      }),
      prisma.closure.findFirst({
        where: { establishmentId: eid, type: "DAILY", periodStart: { gte: start } },
      }),
    ]);

    // ── Totaux ────────────────────────────────────────────────
    const totalTtc = tickets.reduce((s, t) => s + parseFloat(t.finalAmount), 0);
    const totalHt  = tickets.reduce((s, t) => s + parseFloat(t.totalHt),     0);
    const totalTva = tickets.reduce((s, t) => s + parseFloat(t.totalTva),    0);
    const avgBasket = tickets.length > 0 ? totalTtc / tickets.length : 0;

    // ── Ventilation TVA ────────────────────────────────────────
    const tvaMap = {};
    for (const ticket of tickets) {
      for (const line of ticket.lines) {
        const rate = parseFloat(line.tvaRate).toFixed(1);
        if (!tvaMap[rate]) tvaMap[rate] = { rate: parseFloat(rate), baseHt: 0, tvaAmt: 0, totalTtc: 0 };
        tvaMap[rate].baseHt   += parseFloat(line.totalHt);
        tvaMap[rate].tvaAmt   += parseFloat(line.totalTva);
        tvaMap[rate].totalTtc += parseFloat(line.totalTtc);
      }
    }
    const tvaBreakdown = Object.values(tvaMap).map(t => ({
      rate:     t.rate,
      baseHt:   round2(t.baseHt),
      tvaAmt:   round2(t.tvaAmt),
      totalTtc: round2(t.totalTtc),
    }));

    // ── Ventilation paiements ──────────────────────────────────
    const payMap = {};
    for (const ticket of tickets) {
      for (const pay of ticket.payments) {
        const mode = pay.paymentMode.label;
        if (!payMap[mode]) payMap[mode] = { mode, amount: 0, count: 0 };
        payMap[mode].amount += parseFloat(pay.amount);
        payMap[mode].count  += 1;
      }
    }

    // ── Top produits ───────────────────────────────────────────
    const productMap = {};
    for (const ticket of tickets) {
      for (const line of ticket.lines) {
        if (!productMap[line.label]) productMap[line.label] = { label: line.label, qty: 0, revenue: 0 };
        productMap[line.label].qty     += parseFloat(line.qty);
        productMap[line.label].revenue += parseFloat(line.totalTtc);
      }
    }
    const topProducts = Object.values(productMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map(p => ({ ...p, qty: round2(p.qty), revenue: round2(p.revenue) }));

    // ── Ventes par heure ───────────────────────────────────────
    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, tickets: 0, revenue: 0 }));
    for (const ticket of tickets) {
      const h = new Date(ticket.createdAt).getHours();
      hourly[h].tickets  += 1;
      hourly[h].revenue  += parseFloat(ticket.finalAmount);
    }

    res.json({
      date: d.toISOString().slice(0, 10),
      summary: {
        ticketCount:  tickets.length,
        totalTtc:     round2(totalTtc),
        totalHt:      round2(totalHt),
        totalTva:     round2(totalTva),
        avgBasket:    round2(avgBasket),
        closureDone:  !!closureToday,
      },
      tvaBreakdown,
      payBreakdown: Object.values(payMap).map(p => ({ ...p, amount: round2(p.amount) })),
      topProducts,
      hourly,
    });
  } catch (err) { next(err); }
});

// ─── RAPPORT CA SUR PÉRIODE ───────────────────────────────────────
router.get("/revenue",
  query("startDate").isISO8601(),
  query("endDate").isISO8601(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Dates invalides", 400);

      const { startDate, endDate, groupBy = "day" } = req.query;
      const eid = req.establishmentId;

      const tickets = await prisma.ticket.findMany({
        where: {
          establishmentId: eid,
          status:   "PAID",
          createdAt:{ gte: new Date(startDate), lte: new Date(endDate) },
        },
        select: { finalAmount: true, totalHt: true, totalTva: true, createdAt: true },
      });

      // Grouper par jour/semaine/mois
      const groups = {};
      for (const ticket of tickets) {
        const d   = new Date(ticket.createdAt);
        let key;
        if (groupBy === "month") key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
        else if (groupBy === "week") key = getWeekKey(d);
        else key = d.toISOString().slice(0,10);

        if (!groups[key]) groups[key] = { period: key, tickets: 0, totalTtc: 0, totalHt: 0, totalTva: 0 };
        groups[key].tickets  += 1;
        groups[key].totalTtc += parseFloat(ticket.finalAmount);
        groups[key].totalHt  += parseFloat(ticket.totalHt);
        groups[key].totalTva += parseFloat(ticket.totalTva);
      }

      const data = Object.values(groups)
        .sort((a, b) => a.period.localeCompare(b.period))
        .map(g => ({
          ...g,
          totalTtc: round2(g.totalTtc),
          totalHt:  round2(g.totalHt),
          totalTva: round2(g.totalTva),
        }));

      res.json({ data, total: { tickets: tickets.length, ttc: round2(tickets.reduce((s,t)=>s+parseFloat(t.finalAmount),0)) } });
    } catch (err) { next(err); }
});

// ─── RAPPORT TICKET X (intra-journalier, non clôturant) ───────────
router.get("/ticket-x", async (req, res, next) => {
  try {
    const eid   = req.establishmentId;
    const now   = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);

    const tickets = await prisma.ticket.findMany({
      where: { establishmentId: eid, status: "PAID", createdAt: { gte: start } },
      include: {
        lines: { include: { product: { include: { category: true } } } },
        payments: { include: { paymentMode: true } },
      },
    });

    const totalTtc = tickets.reduce((s,t) => s + parseFloat(t.finalAmount), 0);
    const tvaMap = {};
    const payMap = {};
    const catMap = {};

    for (const ticket of tickets) {
      for (const line of ticket.lines) {
        const rate = String(parseFloat(line.tvaRate).toFixed(1));
        if (!tvaMap[rate]) tvaMap[rate] = { rate: parseFloat(rate), baseHt: 0, tvaAmt: 0, totalTtc: 0 };
        tvaMap[rate].baseHt   += parseFloat(line.totalHt);
        tvaMap[rate].tvaAmt   += parseFloat(line.totalTva);
        tvaMap[rate].totalTtc += parseFloat(line.totalTtc);

        const catLabel = line.product?.category?.label || (line.menuId ? 'Menus' : 'Divers');
        if (!catMap[catLabel]) catMap[catLabel] = { category: catLabel, totalHt: 0, totalTtc: 0, qty: 0 };
        catMap[catLabel].totalHt  += parseFloat(line.totalHt);
        catMap[catLabel].totalTtc += parseFloat(line.totalTtc);
        catMap[catLabel].qty      += parseFloat(line.qty);
      }
      for (const pay of ticket.payments) {
        const k = pay.paymentMode.label;
        if (!payMap[k]) payMap[k] = { mode: k, amount: 0 };
        payMap[k].amount += parseFloat(pay.amount);
      }
    }

    res.json({
      type:        "TICKET_X",
      generatedAt: new Date(),
      note:        "Rapport en cours de journée — non clôturant (NF525)",
      period:      { start },
      summary:     { ticketCount: tickets.length, totalTtc: round2(totalTtc) },
      tvaBreakdown:      Object.values(tvaMap).map(t => ({ ...t, baseHt: round2(t.baseHt), tvaAmt: round2(t.tvaAmt), totalTtc: round2(t.totalTtc) })),
      payBreakdown:      Object.values(payMap).map(p => ({ ...p, amount: round2(p.amount) })),
      categoryBreakdown: Object.values(catMap)
        .map(c => ({ ...c, totalHt: round2(c.totalHt), totalTtc: round2(c.totalTtc), qty: round2(c.qty) }))
        .sort((a, b) => b.totalTtc - a.totalTtc),
    });
  } catch (err) { next(err); }
});

// ─── HELPERS ──────────────────────────────────────────────────────
const round2 = n => Math.round(parseFloat(n) * 100) / 100;
function getWeekKey(d) {
  const start = new Date(d);
  start.setDate(d.getDate() - d.getDay() + 1);
  return start.toISOString().slice(0, 10);
}

export default router;
