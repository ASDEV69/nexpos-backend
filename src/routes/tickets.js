// src/routes/tickets.js — Gestion des tickets de caisse (NF525)
import { Router } from "express";
import { body, param, validationResult } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireCashier } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";
import { auditLog } from "../utils/auditLog.js";
import {
  signTicket,
  getNextTicketNumber,
} from "../services/nf525Service.js";
import { earnPoints, useRewardCode } from "../services/loyaltyService.js";

const router = Router();
router.use(authenticate);

// ─── LISTE DES TICKETS ────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { page = 1, limit = 50, status, startDate, endDate, tableId, source } = req.query;

    const where = { establishmentId: req.establishmentId };
    if (status)    where.status  = status;
    if (tableId)   where.tableId = tableId;
    if (source)    where.source  = source;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate)   where.createdAt.lte = new Date(endDate);
    }

    const [tickets, total] = await prisma.$transaction([
      prisma.ticket.findMany({
        where,
        include: {
          lines:    { include: { product: { select: { name: true, emoji: true } } } },
          payments: { include: { paymentMode: true } },
          user:     { select: { name: true, initial: true } },
          table:    { select: { label: true } },
        },
        orderBy: { number: "desc" },
        skip:  (parseInt(page) - 1) * parseInt(limit),
        take:  parseInt(limit),
      }),
      prisma.ticket.count({ where }),
    ]);

    res.json({ tickets, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { next(err); }
});

// ─── CRÉER UN TICKET (OPEN) ───────────────────────────────────────
router.post("/",
  requireCashier,
  body("tableId").optional().isString(),
  body("customerId").optional().isUUID(),
  body("covers").optional().isInt({ min: 1 }),
  body("orderMode").optional().isIn(["DINE_IN","TAKEAWAY","DELIVERY","KIOSK"]),
  body("source").optional().isIn(["CASHIER","WAITER","KIOSK","UBER_EATS","DELIVEROO"]),
  body("note").optional().isString().trim(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);

      const { tableId, customerId, covers = 1, orderMode = "DINE_IN", source = "CASHIER", note } = req.body;

      // Vérifier que le client appartient bien à cet établissement
      if (customerId) {
        const customer = await prisma.customer.findFirst({
          where: { id: customerId, establishmentId: req.establishmentId },
        });
        if (!customer) throw new AppError("Client introuvable", 404);
      }

      const number = await getNextTicketNumber(req.establishmentId);

      const ticket = await prisma.ticket.create({
        data: {
          establishmentId: req.establishmentId,
          userId:          req.user.id,
          tableId:         tableId  || null,
          customerId:      customerId || null,
          number,
          orderMode,
          covers,
          source,
          note,
          status: "OPEN",
        },
        include: { lines: true, user: { select: { name: true, initial: true } } },
      });

      // Mettre à jour le statut de la table
      if (tableId) {
        await prisma.table.update({
          where: { id: tableId },
          data: { status: "OCCUPIED" },
        });
      }

      req.io?.to(req.establishmentId).emit("ticket:created", ticket);

      // 🍳 Émettre l'impression du bon cuisine vers le serveur de périphériques
      req.io?.to(`peripherals:${req.establishmentId}`).emit("print:kitchen", {
        order: {
          ticketId:  ticket.id,
          number:    ticket.number,
          orderMode: ticket.orderMode,
          table:     "En attente de table",
          covers:    ticket.covers,
          lines:     ticket.lines.map(l => ({ label: l.label, qty: l.qty, note: l.note })),
          note:      ticket.note,
          createdAt: ticket.createdAt,
        },
      });

      res.status(201).json(ticket);
    } catch (err) { next(err); }
});

// ─── RÉCUPÉRER UN TICKET ──────────────────────────────────────────
router.get("/:id", param("id").isUUID(), async (req, res, next) => {
  try {
    const ticket = await prisma.ticket.findFirst({
      where: { id: req.params.id, establishmentId: req.establishmentId },
      include: {
        lines:        { include: { product: true, menu: true, tvaRateRef: true } },
        payments:     { include: { paymentMode: true } },
        tvaBreakdown: true,
        user:         { select: { name: true, initial: true } },
        table:        { select: { label: true, section: true } },
      },
    });

    if (!ticket) throw new AppError("Ticket introuvable", 404);
    res.json(ticket);
  } catch (err) { next(err); }
});

// ─── AJOUTER/MODIFIER DES LIGNES ─────────────────────────────────
router.put("/:id/lines",
  requireCashier,
  param("id").isUUID(),
  body("lines").isArray({ min: 0 }),
  async (req, res, next) => {
    try {
      const ticket = await prisma.ticket.findFirst({
        where: { id: req.params.id, establishmentId: req.establishmentId },
      });

      if (!ticket) throw new AppError("Ticket introuvable", 404);
      if (ticket.status !== "OPEN") throw new AppError("Ticket déjà validé — impossible de modifier", 422);

      const { lines } = req.body;

      // Recalcul complet — supprimer les anciennes lignes et recréer
      await prisma.$transaction(async (tx) => {
        await tx.ticketLine.deleteMany({ where: { ticketId: ticket.id } });
        await tx.ticketTva.deleteMany({ where: { ticketId: ticket.id } });

        let totalHt = 0, totalTva = 0, totalTtc = 0;
        const tvaMap = {};

        const createdLines = [];
        for (const line of lines) {
          // Récupérer le taux TVA
          const tvaRate = await tx.tvaRate.findFirst({
            where: { establishmentId: req.establishmentId, rate: line.tvaRate },
          });
          if (!tvaRate) throw new AppError(`Taux TVA ${line.tvaRate}% introuvable`, 400);

          const qty        = parseFloat(line.qty);
          const priceTtc   = parseFloat(line.unitPriceTtc);
          const rate       = parseFloat(line.tvaRate);
          const priceHt    = priceTtc / (1 + rate / 100);
          const lineHt     = Math.round(priceHt * qty * 100) / 100;
          const lineTtc    = Math.round(priceTtc * qty * 100) / 100;
          const lineTva    = Math.round((lineTtc - lineHt) * 100) / 100;

          totalHt  += lineHt;
          totalTva += lineTva;
          totalTtc += lineTtc;

          if (!tvaMap[rate]) tvaMap[rate] = { rate, baseHt: 0, tvaAmt: 0, totalTtc: 0 };
          tvaMap[rate].baseHt   += lineHt;
          tvaMap[rate].tvaAmt   += lineTva;
          tvaMap[rate].totalTtc += lineTtc;

          const created = await tx.ticketLine.create({
            data: {
              ticketId:    ticket.id,
              productId:   line.productId || null,
              menuId:      line.menuId    || null,
              tvaRateId:   tvaRate.id,
              label:       line.label,
              qty,
              unitPriceHt: Math.round(priceHt * 10000) / 10000,
              unitPriceTtc:priceTtc,
              tvaRate:     rate,
              totalHt:     lineHt,
              totalTva:    lineTva,
              totalTtc:    lineTtc,
              note:        line.note || null,
              trEligible:  line.trEligible ?? false,
              menuComposition: line.menuComposition || null,
            },
          });
          createdLines.push(created);
        }

        // Ventilation TVA
        for (const [, tva] of Object.entries(tvaMap)) {
          await tx.ticketTva.create({
            data: {
              ticketId: ticket.id,
              rate:     tva.rate,
              baseHt:   Math.round(tva.baseHt   * 100) / 100,
              tvaAmt:   Math.round(tva.tvaAmt   * 100) / 100,
              totalTtc: Math.round(tva.totalTtc * 100) / 100,
            },
          });
        }

        // Mise à jour du ticket
        await tx.ticket.update({
          where: { id: ticket.id },
          data: {
            totalHt:     Math.round(totalHt  * 100) / 100,
            totalTva:    Math.round(totalTva * 100) / 100,
            totalTtc:    Math.round(totalTtc * 100) / 100,
            finalAmount: Math.round(totalTtc * 100) / 100,
          },
        });
      });

      const updated = await prisma.ticket.findUnique({
        where: { id: ticket.id },
        include: { lines: true, tvaBreakdown: true, customer: true },
      });

      req.io?.to(req.establishmentId).emit("ticket:updated", updated);

      // 🍳 KDS : pas de notification ici — l'ordre n'est envoyé au KDS
      //         qu'après encaissement (POST /:id/pay) ou validation caisse (POST /:id/send-kitchen)

      // Émettre l'impression du bon cuisine vers le serveur de périphériques
      req.io?.to(`peripherals:${req.establishmentId}`).emit("print:kitchen", {
        order: {
          ticketId:  updated.id,
          number:    updated.number,
          orderMode: updated.orderMode,
          table:     updated.table?.label || "Droit devant",
          covers:    updated.covers,
          lines:     updated.lines.map(l => ({ label: l.label, qty: l.qty, note: l.note })),
          note:      updated.note,
          createdAt: updated.createdAt,
        },
      });

      res.json(updated);
    } catch (err) { next(err); }
});

// ─── APPLIQUER UNE REMISE ─────────────────────────────────────────
router.patch("/:id/discount",
  requireCashier,
  param("id").isUUID(),
  body("type").isIn(["PCT","EUR"]),
  body("value").isFloat({ min: 0 }),
  async (req, res, next) => {
    try {
      const ticket = await prisma.ticket.findFirst({
        where: { id: req.params.id, establishmentId: req.establishmentId },
      });

      if (!ticket) throw new AppError("Ticket introuvable", 404);
      if (ticket.status !== "OPEN") throw new AppError("Ticket déjà validé", 422);

      const { type, value } = req.body;
      const base = parseFloat(ticket.totalTtc);
      const discountAmt = type === "PCT"
        ? Math.round(base * (value / 100) * 100) / 100
        : Math.min(value, base);

      await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          discountType:   type,
          discountValue:  value,
          discountAmount: discountAmt,
          finalAmount:    Math.round((base - discountAmt) * 100) / 100,
        },
      });

      const updated = await prisma.ticket.findUnique({
        where: { id: ticket.id },
        include: { lines: true, payments: true, tvaBreakdown: true },
      });

      console.log(`[WS] Emit ticket:updated to room ${req.establishmentId}`);
      req.io?.to(req.establishmentId).emit("ticket:updated", updated);

      res.json({ discountAmount: discountAmt, finalAmount: base - discountAmt, ticket: updated });
    } catch (err) { next(err); }
});

// ─── ENCAISSER (PAYER + SIGNER NF525) ────────────────────────────
router.post("/:id/pay",
  requireCashier,
  param("id").isUUID(),
  body("payments").isArray({ min: 1 }),
  body("payments.*.paymentModeId").isString(),
  body("payments.*.amount").isFloat({ min: 0.01 }),
  body("rewardCode").optional().isString().trim(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: "Données invalides", details: errors.array() });

      const ticket = await prisma.ticket.findFirst({
        where: { id: req.params.id, establishmentId: req.establishmentId },
        include: { lines: true },
      });

      if (!ticket) throw new AppError("Ticket introuvable", 404);
      if (ticket.status !== "OPEN") throw new AppError("Ticket déjà payé ou annulé", 422);

      const { payments, rewardCode } = req.body;

      // ── Appliquer un code récompense fidélité ─────────────────────
      if (rewardCode && ticket.customerId) {
        const reward = await useRewardCode(rewardCode, ticket.id);
        if (reward) {
          let discountAmt = 0;
          const base = parseFloat(ticket.finalAmount);
          if (reward.type === "DISCOUNT_EUR") {
            discountAmt = Math.min(parseFloat(reward.value), base);
          } else if (reward.type === "DISCOUNT_PCT") {
            discountAmt = Math.round(base * (parseFloat(reward.value) / 100) * 100) / 100;
          }
          if (discountAmt > 0) {
            await prisma.ticket.update({
              where: { id: ticket.id },
              data: {
                discountType:   "LOYALTY",
                discountAmount: discountAmt,
                finalAmount:    Math.round((base - discountAmt) * 100) / 100,
              },
            });
            // Recharger le ticket avec le nouveau finalAmount
            Object.assign(ticket, await prisma.ticket.findUnique({
              where: { id: ticket.id },
              include: { lines: true },
            }));
          }
        }
      }

      const totalPaid = payments.reduce((s, p) => s + parseFloat(p.amount), 0);

      if (Math.round(totalPaid * 100) < Math.round(parseFloat(ticket.finalAmount) * 100)) {
        throw new AppError("Montant insuffisant", 422);
      }

      // Vérification TR — si un paiement est en TR, vérifier que tous les articles sont éligibles
      for (const pay of payments) {
        const mode = await prisma.paymentMode.findFirst({
          where: { id: pay.paymentModeId, establishmentId: req.establishmentId },
        });
        if (!mode) throw new AppError("Mode de paiement introuvable", 404);

        if (mode.trAllowed) {
          const nonTrLines = ticket.lines.filter(l => !l.trEligible);
          if (nonTrLines.length > 0) {
            throw new AppError(
              `Paiement TR impossible : ${nonTrLines.length} article(s) non éligible(s) dans le panier`,
              422
            );
          }
        }
      }

      // ── Transaction de paiement ──────────────────────────────
      const paidTicket = await prisma.$transaction(async (tx) => {
        // Décrémenter les stocks
        for (const line of ticket.lines) {
          if (line.productId) {
            await tx.product.updateMany({
              where: { id: line.productId, stockEnabled: true },
              data: { stockQty: { decrement: line.qty } }
            });
          }
        }

        // Créer les lignes de paiement
        for (const pay of payments) {
          await tx.payment.create({
            data: {
              ticketId:      ticket.id,
              paymentModeId: pay.paymentModeId,
              amount:        parseFloat(pay.amount),
              cashGiven:     pay.cashGiven  ? parseFloat(pay.cashGiven)  : null,
              cashChange:    pay.cashChange ? parseFloat(pay.cashChange) : null,
              reference:     pay.reference || null,
            },
          });
        }

        // Récupérer le hash du dernier ticket payé (chaîne NF525)
        const lastPaid = await tx.ticket.findFirst({
          where: {
            establishmentId: req.establishmentId,
            status: "PAID",
            number: { lt: ticket.number },
          },
          orderBy: { number: "desc" },
          select: { hash: true },
        });

        // Récupérer le ticket avec ses paiements pour la signature
        const toSign = await tx.ticket.findUnique({
          where: { id: ticket.id },
          include: { lines: true, payments: true },
        });

        const hash = signTicket(toSign, lastPaid?.hash ?? null);

        // Mettre à jour le statut et signer
        const updated = await tx.ticket.update({
          where: { id: ticket.id },
          data: {
            status:   "PAID",
            hash,
            prevHash: lastPaid?.hash ?? null,
            signedAt: new Date(),
          },
          include: {
            lines:        { include: { tvaRateRef: true } },
            payments:     { include: { paymentMode: true } },
            tvaBreakdown: true,
            user:         { select: { name: true, initial: true } },
            table:        { select: { label: true } },
          },
        });

        // Décrémenter les stocks si activé
        for (const line of ticket.lines) {
          if (line.productId) {
            const product = await tx.product.findUnique({
              where: { id: line.productId },
              select: { stockEnabled: true },
            });
            if (product?.stockEnabled) {
              await tx.product.update({
                where: { id: line.productId },
                data: { stockQty: { decrement: parseFloat(line.qty) } },
              });
              await tx.stockMovement.create({
                data: {
                  establishmentId: req.establishmentId,
                  productId:       line.productId,
                  type:            "SALE",
                  qty:             -parseFloat(line.qty),
                  reference:       `T${ticket.number}`,
                  userId:          req.user.id,
                },
              });
            }
          }
        }

        // Libérer la table
        if (ticket.tableId) {
          await tx.table.update({
            where: { id: ticket.tableId },
            data: { status: "FREE" },
          });
        }

        return updated;
      });

      await auditLog({
        establishmentId: req.establishmentId,
        userId:   req.user.id,
        action:   "PAY_TICKET",
        entity:   "ticket",
        entityId: ticket.id,
        after: { number: ticket.number, amount: ticket.finalAmount, hash: paidTicket.hash },
      });

      // ── Attribution des points fidélité ───────────────────────────
      if (paidTicket.customerId) {
        try {
          const loyalty = await earnPoints(
            paidTicket.customerId,
            paidTicket.id,
            parseFloat(paidTicket.finalAmount),
            req.establishmentId,
          );
          if (loyalty) {
            req.io?.to(req.establishmentId).emit("loyalty:earned", {
              customerId: paidTicket.customerId,
              points:     loyalty.points,
              newBalance: loyalty.newBalance,
              levelUp:    loyalty.levelUp,
              newLevel:   loyalty.newLevel,
            });
          }
        } catch (loyaltyErr) {
          // Non-bloquant : le paiement est déjà enregistré
          console.error("[Loyalty] Erreur attribution points :", loyaltyErr.message);
        }
      }

      req.io?.to(req.establishmentId).emit("ticket:paid", paidTicket);

      // 🍳 KDS : notifier la cuisine uniquement après encaissement
      req.io?.to(`kitchen:${req.establishmentId}`).emit("kds:order", {
        ticketId:  paidTicket.id,
        number:    paidTicket.number,
        table:     paidTicket.table?.label || "Comptoir",
        covers:    paidTicket.covers,
        orderMode: paidTicket.orderMode,
        customer:  paidTicket.customer ?? null,
        note:      paidTicket.note,
        lines:     paidTicket.lines.map(l => ({ label: l.label, qty: l.qty, note: l.note })),
        sentAt:    new Date(),
        paid:      true,
      });

      res.json(paidTicket);
    } catch (err) { next(err); }
});

// ─── ANNULER UN TICKET (NF525) ────────────────────────────────────
router.post("/:id/cancel",
  requireCashier,
  param("id").isUUID(),
  body("reason").notEmpty().isString().trim(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Motif d'annulation obligatoire", 400);

      const ticket = await prisma.ticket.findFirst({
        where: { id: req.params.id, establishmentId: req.establishmentId },
      });

      if (!ticket) throw new AppError("Ticket introuvable", 404);
      if (ticket.status === "CANCELLED") throw new AppError("Ticket déjà annulé", 422);

      // NF525 : Un ticket PAID ne peut pas être simplement annulé.
      // Il faut créer un avoir (ticket d'annulation négatif).
      if (ticket.status === "PAID") {
        throw new AppError(
          "Un ticket encaissé ne peut pas être annulé — créez un avoir via POST /tickets/:id/refund",
          422
        );
      }

      await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          status:        "CANCELLED",
          cancelledAt:   new Date(),
          cancelReason:  req.body.reason,
          cancelledById: req.user.id,
        },
      });

      if (ticket.tableId) {
        await prisma.table.update({
          where: { id: ticket.tableId },
          data: { status: "FREE" },
        });
      }

      await auditLog({
        establishmentId: req.establishmentId,
        userId:   req.user.id,
        action:   "CANCEL_TICKET",
        entity:   "ticket",
        entityId: ticket.id,
        after: { reason: req.body.reason },
      });

      req.io?.to(req.establishmentId).emit("ticket:cancelled", { id: ticket.id });
      res.json({ message: "Ticket annulé", id: ticket.id });
    } catch (err) { next(err); }
});

// ─── ENVOYER EN CUISINE (KDS) ─────────────────────────────────────
router.post("/:id/send-kitchen",
  requireCashier,
  param("id").isUUID(),
  async (req, res, next) => {
    try {
      const ticket = await prisma.ticket.findFirst({
        where: { id: req.params.id, establishmentId: req.establishmentId },
        include: { lines: true, table: { select: { label: true } }, customer: true },
      });

      if (!ticket) throw new AppError("Ticket introuvable", 404);

      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { status: "SENT" },
      });

      // Émettre vers le KDS cuisine
      req.io?.to(`kitchen:${req.establishmentId}`).emit("kds:order", {
        ticketId: ticket.id,
        number:   ticket.number,
        table:    ticket.table?.label,
        covers:   ticket.covers,
        orderMode:ticket.orderMode,
        customer: ticket.customer,
        note:     ticket.note,
        lines:    ticket.lines.map(l => ({ label: l.label, qty: l.qty, note: l.note })),
        sentAt:   new Date(),
      });

      const updated = await prisma.ticket.findUnique({
        where: { id: ticket.id },
        include: { lines: true, table: { select: { label: true } } },
      });

      console.log(`[WS] Emit ticket:updated (SENT) to room ${req.establishmentId}`);
      req.io?.to(req.establishmentId).emit("ticket:updated", updated);

      // 🍳 Émettre l'impression du bon cuisine vers le serveur de périphériques
      req.io?.to(`peripherals:${req.establishmentId}`).emit("print:kitchen", {
        order: {
          ticketId:  ticket.id,
          number:    ticket.number,
          orderMode: ticket.orderMode,
          table:     ticket.table?.label || "Comptoir",
          covers:    ticket.covers,
          lines:     ticket.lines.map(l => ({ label: l.label, qty: l.qty, note: l.note })),
          note:      ticket.note,
          createdAt: ticket.createdAt,
        },
      });
      console.log(`[Printer] Impression bon cuisine T#${ticket.number} émise`);

      res.json({ message: "Envoyé en cuisine et impression lancée", status: "SENT", ticket: updated });
    } catch (err) { next(err); }
});

export default router;
