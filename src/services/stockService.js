// src/services/stockService.js — Gestion complète des stocks
// Phase 3 — Intégration dans le backend NEXPOS
import { prisma } from "../utils/prisma.js";
import { logger } from "../utils/logger.js";

// ─── MOUVEMENTS DE STOCK ─────────────────────────────────────────

/**
 * Enregistre un mouvement de stock et met à jour la quantité.
 * Toutes les opérations sont tracées (NF525 / traçabilité).
 */
export async function createStockMovement({
  establishmentId,
  productId,
  type,         // SALE | PURCHASE | ADJUSTMENT | WASTE | TRANSFER
  qty,          // positif = entrée, négatif = sortie
  reason,
  reference,    // N° ticket, N° BL, etc.
  userId,
  lotNumber,
  dlcDate,      // Date Limite de Consommation
  unitCost,     // Pour valorisation FIFO/CUMP
}) {
  return await prisma.$transaction(async (tx) => {
    // Vérifier stock suffisant pour les sorties
    if (qty < 0) {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { stockQty: true, name: true, stockEnabled: true },
      });

      if (product?.stockEnabled && parseFloat(product.stockQty) + qty < 0) {
        logger.warn(`[Stock] Alerte stock négatif: ${product.name} — Qté actuelle: ${product.stockQty}, Sortie: ${qty}`);
        // On laisse passer (stock négatif possible) mais on log
      }
    }

    const move = await tx.stockMovement.create({
      data: {
        establishmentId,
        productId,
        type,
        qty: parseFloat(qty),
        reason:    reason    || null,
        reference: reference || null,
        userId:    userId    || null,
      },
    });

    // Mise à jour de la quantité en stock
    await tx.product.update({
      where: { id: productId },
      data:  { stockQty: { increment: parseFloat(qty) } },
    });

    return move;
  });
}

/**
 * Traite toutes les sorties de stock suite à un ticket payé.
 * Appelé automatiquement lors du paiement (POST /tickets/:id/pay).
 */
export async function processTicketStockMovements(ticket, userId) {
  const promises = [];

  for (const line of ticket.lines) {
    if (!line.productId) continue;

    const product = await prisma.product.findUnique({
      where:  { id: line.productId },
      select: { stockEnabled: true, stockQty: true, stockAlert: true, name: true },
    });

    if (!product?.stockEnabled) continue;

    await createStockMovement({
      establishmentId: ticket.establishmentId,
      productId:       line.productId,
      type:            "SALE",
      qty:             -parseFloat(line.qty),
      reference:       `T${ticket.number}`,
      reason:          `Vente ticket #${ticket.number}`,
      userId,
    });

    // Vérifier alerte stock bas
    const newQty = parseFloat(product.stockQty) - parseFloat(line.qty);
    if (product.stockAlert && newQty <= parseFloat(product.stockAlert)) {
      logger.warn(`[Stock] ⚠️ Stock bas: ${product.name} — Restant: ${newQty.toFixed(2)}`);
      promises.push(createStockAlert(ticket.establishmentId, line.productId, newQty, product));
    }
  }

  await Promise.all(promises);
}

/**
 * Inventaire : ajuste les quantités selon un comptage physique.
 * Crée un mouvement ADJUSTMENT pour chaque différence.
 */
export async function processInventory(establishmentId, userId, counts) {
  // counts = [{ productId, countedQty }]
  const results = [];

  for (const { productId, countedQty } of counts) {
    const product = await prisma.product.findUnique({
      where:  { id: productId },
      select: { stockQty: true, name: true },
    });

    if (!product) continue;

    const systemQty = parseFloat(product.stockQty);
    const diff      = countedQty - systemQty;

    if (Math.abs(diff) < 0.001) {
      results.push({ productId, name: product.name, diff: 0, status: "ok" });
      continue;
    }

    await createStockMovement({
      establishmentId,
      productId,
      type:      "ADJUSTMENT",
      qty:       diff,
      reason:    "Inventaire physique",
      reference: `INV-${new Date().toISOString().slice(0, 10)}`,
      userId,
    });

    results.push({
      productId,
      name:      product.name,
      before:    systemQty,
      after:     countedQty,
      diff,
      status:    diff > 0 ? "gain" : "loss",
    });
  }

  logger.info(`[Stock] Inventaire traité: ${results.length} articles, ${results.filter(r=>r.diff!==0).length} écarts`);
  return results;
}

/**
 * Valorisation du stock (CUMP — Coût Unitaire Moyen Pondéré).
 * Calcule la valeur totale du stock pour la comptabilité.
 */
export async function getStockValuation(establishmentId) {
  const products = await prisma.product.findMany({
    where:  { establishmentId, stockEnabled: true, active: true },
    select: { id: true, name: true, emoji: true, stockQty: true, price: true },
  });

  let totalValue = 0;
  const items = products.map(p => {
    const qty   = parseFloat(p.stockQty || 0);
    const price = parseFloat(p.price);
    // Valeur HT (prix TTC / 1.1 pour TVA 10% — simplification)
    const valueHt = qty * (price / 1.10);
    totalValue += valueHt;
    return {
      id:      p.id,
      name:    p.name,
      emoji:   p.emoji,
      qty:     Math.round(qty * 1000) / 1000,
      price,
      valueHt: Math.round(valueHt * 100) / 100,
    };
  });

  return {
    items,
    totalValue:     Math.round(totalValue * 100) / 100,
    itemCount:      items.length,
    generatedAt:    new Date(),
  };
}

/**
 * Produits en alerte de stock bas.
 */
export async function getStockAlerts(establishmentId) {
  const products = await prisma.product.findMany({
    where: {
      establishmentId,
      stockEnabled: true,
      active:       true,
      stockAlert:   { not: null },
    },
    include: { category: { select: { label: true, icon: true } } },
  });

  return products
    .filter(p => parseFloat(p.stockQty) <= parseFloat(p.stockAlert))
    .map(p => ({
      id:         p.id,
      name:       p.name,
      emoji:      p.emoji,
      category:   p.category?.label,
      stockQty:   parseFloat(p.stockQty),
      stockAlert: parseFloat(p.stockAlert),
      deficit:    Math.max(0, parseFloat(p.stockAlert) - parseFloat(p.stockQty)),
      critical:   parseFloat(p.stockQty) <= 0,
    }));
}

/**
 * Génère un bon de commande fournisseur pour les articles en alerte.
 */
export async function generatePurchaseOrder(establishmentId, productIds, supplierId) {
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, establishmentId },
    select: { id: true, name: true, emoji: true, stockQty: true, stockAlert: true },
  });

  const lines = products.map(p => ({
    productId:  p.id,
    name:       p.name,
    emoji:      p.emoji,
    currentQty: parseFloat(p.stockQty),
    alertQty:   parseFloat(p.stockAlert),
    // Suggérer de commander le double du seuil d'alerte
    suggestedQty: Math.max(1, parseFloat(p.stockAlert) * 2 - parseFloat(p.stockQty)),
  }));

  return {
    id:           `BC-${Date.now()}`,
    establishmentId,
    supplierId:   supplierId || null,
    createdAt:    new Date(),
    lines,
    status:       "draft",
  };
}

async function createStockAlert(establishmentId, productId, qty, product) {
  logger.warn(`[Stock] ALERTE: ${product.name} — ${qty.toFixed(2)} unités restantes (seuil: ${product.stockAlert})`);
}
