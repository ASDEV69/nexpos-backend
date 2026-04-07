// src/services/franchiseService.js — Logique métier Royalties & Centrale d'Achat
import { prisma } from "../utils/prisma.js";
import { logger } from "../utils/logger.js";

/**
 * Calcule et génère les factures de redevances pour un groupe sur une période donnée (mois).
 * @param {string} groupId 
 * @param {string} period Format "YYYY-MM"
 */
export async function generateMonthlyRoyalties(groupId, period) {
  logger.info(`[Franchise] Génération redevances pour le groupe ${groupId} — Période: ${period}`);

  // 1. Récupérer le rapport consolidé pour ce mois
  // On assume que le rapport mensuel a déjà été généré
  const [year, month] = period.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end   = new Date(year, month, 0, 23, 59, 59);

  const report = await prisma.consolidatedReport.findFirst({
    where: { 
      groupId, 
      type: "MONTHLY",
      periodStart: { gte: start },
      periodEnd:   { lte: end }
    }
  });

  if (!report) {
    throw new Error(`Aucun rapport mensuel consolidé trouvé pour la période ${period}. Veuillez en générer un d'abord.`);
  }

  const results = [];
  const establishmentsData = report.byEstablishment; // Array de { id, name, totalHt, ... }

  for (const estabData of establishmentsData) {
    // 2. Trouver la configuration de redevance pour cet établissement
    let config = await prisma.royaltyConfig.findUnique({
      where: { establishmentId: estabData.id }
    });

    // Fallback sur la config par défaut du groupe (sans establishmentId)
    if (!config) {
      config = await prisma.royaltyConfig.findFirst({
        where: { groupId, establishmentId: null, active: true }
      });
    }

    if (!config) {
      logger.warn(`[Franchise] Aucune configuration de redevance pour l'établissement ${estabData.name}`);
      continue;
    }

    // 3. Calcul
    const caHt = parseFloat(estabData.totalHt);
    const royaltyPercentage = (caHt * parseFloat(config.percentage)) / 100;
    const totalRoyalty = royaltyPercentage + parseFloat(config.fixedMonthly);

    // 4. Upsert Invoice
    const invoice = await prisma.royaltyInvoice.upsert({
      where: { 
        establishmentId_period: { establishmentId: estabData.id, period } 
      },
      update: {
        amountCa:      caHt,
        amountRoyalty: totalRoyalty,
        status:        "PENDING"
      },
      create: {
        groupId,
        establishmentId: estabData.id,
        period,
        amountCa:      caHt,
        amountRoyalty: totalRoyalty,
        status:        "PENDING"
      }
    });

    results.push(invoice);
  }

  return results;
}

/**
 * Gestion des Commandes Fournisseurs
 */

export async function createPurchaseOrder(establishmentId, supplierId, lines, note) {
  const supplier = await prisma.supplier.findUnique({
    where: { id: supplierId },
    include: { products: true }
  });

  if (!supplier) throw new Error("Fournisseur introuvable");

  // Calcul du total
  let totalTtc = 0;
  const processedLines = lines.map(line => {
    const product = supplier.products.find(p => p.id === line.productId);
    if (!product) throw new Error(`Produit ${line.productId} non trouvé chez ce fournisseur`);
    
    const lineTotal = parseFloat(product.price) * line.qty;
    const lineTva   = lineTotal * (parseFloat(product.tax) / 100);
    totalTtc += (lineTotal + lineTva);

    return {
      productId: product.id,
      name:      product.name,
      qty:       line.qty,
      unit:      product.unit,
      price:     parseFloat(product.price),
      tax:       parseFloat(product.tax),
      total:     lineTotal + lineTva
    };
  });

  const orderNumber = `BC-${Date.now().toString().slice(-8)}`;

  const order = await prisma.purchaseOrder.create({
    data: {
      establishmentId,
      supplierId,
      number:   orderNumber,
      totalTtc: Math.round(totalTtc * 100) / 100,
      lines:    processedLines,
      note,
      status:   "DRAFT"
    }
  });

  return order;
}

export async function receivePurchaseOrder(orderId) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId }
  });

  if (!order || order.status !== "SENT") {
    throw new Error("La commande doit être en statut ENVOYÉ pour être réceptionnée");
  }

  // TODO: Mettre à jour les stocks locaux si nécessaire
  // Pour l'instant on marque juste comme reçu
  return prisma.purchaseOrder.update({
    where: { id: orderId },
    data: { 
      status: "RECEIVED",
      receivedAt: new Date()
    }
  });
}
