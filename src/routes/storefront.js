// src/routes/storefront.js — API Publique pour la Commande Client (Sur site & Click/Collect)
import { Router } from "express";
import { body, param, validationResult } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { AppError } from "../middleware/errorHandler.js";
import { getNextTicketNumber, signTicket } from "../services/nf525Service.js";

const router = Router();

// ─── 1. INFOS ÉTABLISSEMENT & CATALOGUE ────────────────────────────
router.get("/:establishmentId/catalog",
  async (req, res, next) => {
    try {
      let targetId = req.params.establishmentId;
      if (targetId === "demo") {
        // Prendre le premier établissement qui a des produits actifs
        const firstEst = await prisma.establishment.findFirst({
          where: { categories: { some: { products: { some: { active: true } } } } },
          orderBy: { createdAt: "asc" },
        });
        if (firstEst) targetId = firstEst.id;
      }

      const establishment = await prisma.establishment.findUnique({
        where: { id: targetId },
        select: { id: true, name: true, logo: true, currency: true, city: true, address: true, zipCode: true, phone: true, siret: true, vatNumber: true, email: true },
      });

      if (!establishment) throw new AppError("Établissement introuvable", 404);

      // Récupérer les catégories avec leurs produits actifs
      const categories = await prisma.category.findMany({
        where: { establishmentId: targetId, kioskEnabled: true },
        orderBy: { sortOrder: "asc" },
        include: {
          products: {
            where: { active: true },
            // On vérifie le stock si géré
            select: { 
              id: true, name: true, description: true, price: true, emoji: true, img: true, stockEnabled: true, stockQty: true, 
              tvaRate: { select: { rate: true } },
              accompaniments: {
                where: { accompaniment: { active: true } },
                select: {
                  id: true, type: true, label: true, priceExtra: true, required: true,
                  accompaniment: { select: { id: true, name: true, emoji: true, img: true } }
                }
              }
            },
          },
        },
      });

      // Nettoyer les catégories vides ou les produits en rupture d'inventaire
      const catalog = categories.map(cat => ({
        ...cat,
        products: cat.products.map(p => ({
            ...p,
            outOfStock: p.stockEnabled && parseFloat(p.stockQty) <= 0
        }))
      })).filter(cat => cat.products.length > 0);

      res.json({ establishment, catalog });
    } catch (err) { next(err); }
});

// ─── 2. CRÉATION D'UNE COMMANDE CLIENT (NON AUTHENTIFIÉE) ──────────
router.post("/:establishmentId/order",
  body("orderMode").isIn(["TAKEAWAY", "DINE_IN"]),
  body("lines").isArray({ min: 1 }),
  body("lines.*.productId").isString().notEmpty(),
  body("lines.*.qty").isNumeric(),
  body("lines.*.extras").optional().isArray(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error("[STOREFRONT] Validation Errors:", JSON.stringify(errors.array()));
        throw new AppError("Panier invalide (Validation)", 400);
      }

      let estId = req.params.establishmentId;
      if (estId === "demo") {
        const firstEst = await prisma.establishment.findFirst({
          where: { categories: { some: { products: { some: { active: true } } } } },
          orderBy: { createdAt: "asc" },
        });
        if (firstEst) estId = firstEst.id;
      }

      const { orderMode, tableId, lines, customerName, customerNote } = req.body;

      const number = await getNextTicketNumber(estId);

      // Le système va re-calculer tous les prix (on ne fait pas confiance au client)
      const ticketResult = await prisma.$transaction(async (tx) => {
        let totalHt = 0, totalTva = 0, totalTtc = 0;
        const tvaMap = {};
        const ticketLines = [];

        for (const line of lines) {
          const product = await tx.product.findFirst({
            where: { id: line.productId, establishmentId: estId, active: true },
            include: { tvaRate: true, accompaniments: true },
          });

          if (!product) throw new AppError(`Produit non valide : ${line.productId}`, 400);
          if (product.stockEnabled && parseFloat(product.stockQty) < line.qty) {
            throw new AppError(`Stock insuffisant pour ${product.name}`, 422);
          }

          let extraPrice = 0;
          let extraLabels = [];
          let menuComposition = [];
          if (line.extras && Array.isArray(line.extras)) {
            for (const extraId of line.extras) {
              const acc = await tx.productAccompaniment.findFirst({
                  where: { id: extraId, productId: product.id, type: { not: "SUGGESTION" } },
                  include: { accompaniment: true }
              });
              if (acc) {
                const price = parseFloat(acc.priceExtra);
                const name  = acc.label || acc.accompaniment.name;
                extraPrice += price;
                extraLabels.push(price > 0 ? `${name} (+${price.toFixed(2)} €)` : name);
                menuComposition.push({ name, price });
              }
            }
          }

          const qty      = parseInt(line.qty);
          const basePriceTtc = parseFloat(product.price);
          const priceTtc = basePriceTtc + extraPrice;
          const rate     = parseFloat(product.tvaRate.rate);
          const priceHt  = priceTtc / (1 + rate / 100);
          
          const lineHt  = Math.round(priceHt * qty * 100) / 100;
          const lineTtc = Math.round(priceTtc * qty * 100) / 100;
          const lineTva = Math.round((lineTtc - lineHt) * 100) / 100;

          totalHt  += lineHt;
          totalTva += lineTva;
          totalTtc += lineTtc;

          if (!tvaMap[rate]) tvaMap[rate] = { rate, baseHt: 0, tvaAmt: 0, totalTtc: 0 };
          tvaMap[rate].baseHt   += lineHt;
          tvaMap[rate].tvaAmt   += lineTva;
          tvaMap[rate].totalTtc += lineTtc;

          ticketLines.push({
            productId:   product.id,
            tvaRateId:   product.tvaRate.id,
            label:       product.name,
            qty,
            unitPriceHt: Math.round(priceHt * 10000) / 10000,
            unitPriceTtc: priceTtc,
            tvaRate:     rate,
            totalHt:     lineHt,
            totalTva:    lineTva,
            totalTtc:    lineTtc,
            trEligible:  product.trEligible,
            note:            extraLabels.length > 0 ? extraLabels.join(', ') : null,
            menuComposition: menuComposition.length > 0 ? menuComposition : undefined
          });
        }

        const noteFinale = `Client: ${customerName || "Inconnu"}${customerNote ? " — " + customerNote : ""}`;

        const ticket = await tx.ticket.create({
          data: {
            establishmentId: estId,
            userId:          null, // Client public
            tableId:         tableId || null,
            number,
            orderMode,
            source:          "KIOSK",
            status:          "OPEN", // La commande apparaît ouverte sur la caisse (En attente de paiement)
            covers:          1,
            note:            noteFinale,
            totalHt:         Math.round(totalHt * 100) / 100,
            totalTva:        Math.round(totalTva * 100) / 100,
            totalTtc:        Math.round(totalTtc * 100) / 100,
            finalAmount:     Math.round(totalTtc * 100) / 100,
            lines: {
              create: ticketLines
            },
            tvaBreakdown: {
              create: Object.values(tvaMap).map(t => ({
                rate:     t.rate,
                baseHt:   Math.round(t.baseHt * 100) / 100,
                tvaAmt:   Math.round(t.tvaAmt * 100) / 100,
                totalTtc: Math.round(t.totalTtc * 100) / 100,
              }))
            }
          },
          include: { lines: true, table: { select: { label: true } } }
        });

        // 🟢 Notification vers le dashboard (pas de KDS — l'ordre n'est envoyé
        //    au KDS qu'après encaissement ou validation depuis la caisse)
        if (req.io) {
          req.io.to(estId).emit("ticket:created", ticket);
        }

        // 🍳 Émettre l'impression du bon cuisine vers le serveur de périphériques (borne)
        if (req.io) {
          req.io.to(`peripherals:${estId}`).emit("print:kitchen", {
            order: {
              ticketId:  ticket.id,
              number:    ticket.number,
              orderMode: ticket.orderMode,
              table:     ticket.table?.label || "Borne kiosk",
              covers:    ticket.covers,
              lines:     ticket.lines.map(l => ({ label: l.label, qty: l.qty, note: l.note })),
              note:      ticket.note,
              createdAt: ticket.createdAt,
            },
          });
        }

        return ticket;
      });

      res.status(201).json({
        success: true,
        ticketId: ticketResult.id,
        ticketNumber: ticketResult.number,
        finalAmount: ticketResult.finalAmount,
        lines: ticketResult.lines,
      });
    } catch (err) { next(err); }
});

// ─── 3. PAIEMENT CARTE BANCAIRE (AUTO-PAY SUR BORNE) ──────────────────
router.post("/:establishmentId/order/:ticketId/pay",
  param("establishmentId").isString(),
  param("ticketId").isString(),
  async (req, res, next) => {
    try {
      let estId = req.params.establishmentId;
      if (estId === "demo") {
        const firstEst = await prisma.establishment.findFirst({
          where: { categories: { some: { products: { some: { active: true } } } } },
          orderBy: { createdAt: "asc" },
        });
        if (firstEst) estId = firstEst.id;
      }
      const { ticketId } = req.params;
      
      const ticket = await prisma.ticket.findFirst({
        where: { id: ticketId, establishmentId: estId, source: "KIOSK", status: "OPEN" },
        include: { lines: true }
      });
      
      if (!ticket) throw new AppError("Commande introuvable ou déjà payée.", 404);

      // Trouver le mode de paiement CB
      let cbMode = await prisma.paymentMode.findFirst({
        where: { establishmentId: estId, label: { contains: "Carte" }, active: true }
      });
      if (!cbMode) {
        cbMode = await prisma.paymentMode.findFirst({ where: { establishmentId: estId, active: true } });
      }
      if (!cbMode) throw new AppError("Aucun mode de paiement configuré.", 500);

      const updatedTicket = await prisma.$transaction(async (tx) => {
        // 1. Décrémenter stocks
        for (const line of ticket.lines) {
          if (line.productId) {
            await tx.product.updateMany({
              where: { id: line.productId, stockEnabled: true },
              data: { stockQty: { decrement: line.qty } }
            });
          }
        }

        // 2. Créer le paiement
        await tx.payment.create({
          data: {
            ticketId: ticket.id,
            paymentModeId: cbMode.id,
            amount: ticket.finalAmount,
          }
        });

        // 3. Signature NF525 (chaînage)
        const lastPaid = await tx.ticket.findFirst({
          where: { establishmentId: estId, status: "PAID", number: { lt: ticket.number } },
          orderBy: { number: "desc" },
          select: { hash: true }
        });

        const toSign = await tx.ticket.findUnique({
          where: { id: ticket.id },
          include: { lines: true, payments: true }
        });

        const hash = signTicket(toSign, lastPaid?.hash ?? null);

        return await tx.ticket.update({
          where: { id: ticket.id },
          data: {
            status: "PAID",
            hash,
            prevHash: lastPaid?.hash ?? null,
            signedAt: new Date()
          },
          include: { 
            lines: true, 
            payments: { include: { paymentMode: true } }
          }
        });
      });

      if (req.io) {
        req.io.to(estId).emit("ticket:paid", updatedTicket);

        // 🍳 KDS : notifier la cuisine après paiement CB borne
        req.io.to(`kitchen:${estId}`).emit("kds:order", {
          ticketId:  updatedTicket.id,
          number:    updatedTicket.number,
          table:     "Borne kiosk",
          covers:    updatedTicket.covers,
          orderMode: updatedTicket.orderMode,
          note:      updatedTicket.note,
          lines:     updatedTicket.lines.map(l => ({ label: l.label, qty: l.qty, note: l.note })),
          sentAt:    new Date(),
          paid:      true,
        });
      }

      res.json({ success: true, ticket: updatedTicket });
    } catch (err) { next(err); }
});

export default router;
