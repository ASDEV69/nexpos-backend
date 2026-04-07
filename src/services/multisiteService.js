import { prisma } from "../utils/prisma.js";
import { logger } from "../utils/logger.js";
import crypto from "crypto";

const JWT_SECRET = process.env.JWT_SECRET || "nexpos_fiscal_secret_2024";

/** 
 * Signe un rapport consolidé pour garantir l'intégrité (NF525 style).
 */
function signReport(reportData, previousSignature = "") {
  const dataString = `${reportData.groupId}|${reportData.type}|${reportData.periodStart}|${reportData.periodEnd}|${reportData.totalTtc}|${previousSignature}`;
  return crypto.createHmac("sha256", JWT_SECRET).update(dataString).digest("hex");
}

// ─── RAPPORT CONSOLIDÉ ────────────────────────────────────────────

/**
 * Génère un rapport consolidé pour un groupe sur une période.
 * Agrège les données de TOUS les établissements du groupe.
 */
export async function generateConsolidatedReport(groupId, periodStart, periodEnd, type = "CUSTOM") {
  logger.info(`[Multisite] Rapport consolidé — groupe ${groupId}`);

  // Récupérer tous les établissements du groupe
  const establishments = await prisma.establishment.findMany({
    where: { groupId },
    select: { id: true, name: true, city: true },
  });

  if (establishments.length === 0) {
    throw new Error("Aucun établissement actif dans ce groupe");
  }

  // Agréger les tickets de chaque établissement
  const byEstab = [];
  let totalTtc = 0, totalHt = 0, totalTva = 0, ticketCount = 0;
  const tvaMap = {}, payMap = {}, productMap = {};

  for (const estab of establishments) {
    const tickets = await prisma.ticket.findMany({
      where: {
        establishmentId: estab.id,
        status: "PAID",
        createdAt: { gte: periodStart, lte: periodEnd },
      },
      include: {
        lines:    true,
        payments: { include: { paymentMode: true } },
      },
    });

    const estabTtc = tickets.reduce((s, t) => s + parseFloat(t.finalAmount), 0);
    const estabHt  = tickets.reduce((s, t) => s + parseFloat(t.totalHt), 0);
    const estabTva = tickets.reduce((s, t) => s + parseFloat(t.totalTva), 0);

    // Ventilation TVA consolidée
    for (const ticket of tickets) {
      for (const line of ticket.lines) {
        const rate = String(parseFloat(line.tvaRate).toFixed(1));
        if (!tvaMap[rate]) tvaMap[rate] = { rate: parseFloat(rate), baseHt: 0, tvaAmt: 0, totalTtc: 0 };
        tvaMap[rate].baseHt   += parseFloat(line.totalHt);
        tvaMap[rate].tvaAmt   += parseFloat(line.totalTva);
        tvaMap[rate].totalTtc += parseFloat(line.totalTtc);

        // Top produits groupe
        const key = line.label;
        if (!productMap[key]) productMap[key] = { label: key, qty: 0, revenue: 0 };
        productMap[key].qty     += parseFloat(line.qty);
        productMap[key].revenue += parseFloat(line.totalTtc);
      }
      // Ventilation paiements
      for (const pay of ticket.payments) {
        const mode = pay.paymentMode?.label || "?";
        if (!payMap[mode]) payMap[mode] = { mode, amount: 0, count: 0 };
        payMap[mode].amount += parseFloat(pay.amount);
        payMap[mode].count  += 1;
      }
    }

    byEstab.push({
      id:          estab.id,
      name:        estab.name,
      city:        estab.city,
      totalTtc:    r2(estabTtc),
      totalHt:     r2(estabHt),
      totalTva:    r2(estabTva),
      ticketCount: tickets.length,
      avgBasket:   tickets.length > 0 ? r2(estabTtc / tickets.length) : 0,
      share:       0, // calculé après
    });

    totalTtc    += estabTtc;
    totalHt     += estabHt;
    totalTva    += estabTva;
    ticketCount += tickets.length;
  }

  // Calcul des parts de marché internes
  byEstab.forEach(e => {
    e.share = totalTtc > 0 ? r2(e.totalTtc / totalTtc * 100) : 0;
  });

  // Classement par CA décroissant
  byEstab.sort((a, b) => b.totalTtc - a.totalTtc);

  // Top 10 produits groupe
  const topProducts = Object.values(productMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10)
    .map(p => ({ ...p, qty: r2(p.qty), revenue: r2(p.revenue) }));

  const reportData = {
    groupId,
    type,
    periodStart,
    periodEnd,
    totalTtc:    r2(totalTtc),
    totalHt:     r2(totalHt),
    totalTva:    r2(totalTva),
    ticketCount,
    byEstablishment: byEstab,
    tvaBreakdown: Object.values(tvaMap).map(t => ({
      rate: t.rate, baseHt: r2(t.baseHt), tvaAmt: r2(t.tvaAmt), totalTtc: r2(t.totalTtc),
    })),
    payBreakdown: Object.values(payMap).map(p => ({
      mode: p.mode, amount: r2(p.amount), count: p.count,
    })),
    topProducts,
  };

  // ─── CHAÎNAGE NF525 RÉSEAU ───
  const lastReport = await prisma.consolidatedReport.findFirst({
    where: { groupId, type },
    orderBy: { periodStart: "desc" }
  });
  const prevSig = lastReport?.signature || "GENESIS_FRANCHISE";
  const signature = signReport(reportData, prevSig);

  const report = await prisma.consolidatedReport.create({
    data: {
      ...reportData,
      signature,
      previousSignature: prevSig
    }
  });

  logger.info(`[Multisite] Rapport ${report.id} généré — ${establishments.length} sites, CA: ${r2(totalTtc)}€`);
  return report;
}

// ─── SYNC CATALOGUE ───────────────────────────────────────────────

/**
 * Pousse un produit central vers tous les établissements du groupe.
 * Respecte les overrides locaux existants.
 * Crée ou met à jour le produit local.
 */
export async function syncProductToAllSites(centralProductId, triggeredBy = null) {
  const central = await prisma.centralProduct.findUnique({
    where:   { id: centralProductId },
    include: { group: { include: { establishments: true } }, centralCategory: true },
  });

  if (!central) throw new Error("Produit central introuvable");
  if (!central.isPropagated) {
    logger.info(`[Sync] Produit ${central.name} non propagé — ignoré`);
    return { skipped: true };
  }

  const results = [];

  for (const estab of central.group.establishments) {
    // Vérifier si override local existe
    const override = await prisma.productSiteOverride.findUnique({
      where: { centralProductId_establishmentId: { centralProductId, establishmentId: estab.id } },
    });

    // Prix effectif: override local ou prix central
    const effectivePrice = override?.localPrice ?? central.basePrice;
    const effectiveName  = override?.localName  ?? central.name;

    // Trouver la catégorie locale correspondante (par label)
    let localCategoryId = null;
    if (central.centralCategory) {
      const localCat = await prisma.category.findFirst({
        where: { establishmentId: estab.id, label: central.centralCategory.label },
      });
      localCategoryId = localCat?.id;
    }

    // Trouver le taux TVA local
    const localTva = await prisma.tvaRate.findFirst({
      where: { establishmentId: estab.id, rate: central.tva },
    });

    if (!localTva || !localCategoryId) {
      await prisma.catalogSyncLog.create({
        data: {
          centralProductId,
          establishmentId: estab.id,
          action:      "CREATE",
          status:      "FAILED",
          error:       `Catégorie ou taux TVA ${central.tva}% introuvable sur ce site`,
          triggeredBy,
        },
      });
      results.push({ estabId: estab.id, status: "FAILED", error: "Config locale manquante" });
      continue;
    }

    // Upsert le produit local
    try {
      const existing = await prisma.product.findFirst({
        where: { establishmentId: estab.id, barcode: central.barcode || undefined },
      });

      if (existing) {
        // Mise à jour seulement si pas d'override prix
        await prisma.product.update({
          where: { id: existing.id },
          data: {
            name:       effectiveName,
            price:      effectivePrice,
            img:        central.img    ?? existing.img,
            emoji:      central.emoji  ?? existing.emoji,
            trEligible: central.trEligible,
            active:     central.active,
          },
        });
        await prisma.catalogSyncLog.create({
          data: { centralProductId, establishmentId: estab.id, action: "UPDATE", status: "SUCCESS", triggeredBy },
        });
        results.push({ estabId: estab.id, status: "UPDATED", name: effectiveName });
      } else {
        await prisma.product.create({
          data: {
            establishmentId: estab.id,
            categoryId:      localCategoryId,
            tvaRateId:       localTva.id,
            name:            effectiveName,
            price:           effectivePrice,
            emoji:           central.emoji,
            img:             central.img,
            trEligible:      central.trEligible,
            barcode:         central.barcode,
            type:            "SINGLE",
          },
        });
        await prisma.catalogSyncLog.create({
          data: { centralProductId, establishmentId: estab.id, action: "CREATE", status: "SUCCESS", triggeredBy },
        });
        results.push({ estabId: estab.id, status: "CREATED", name: effectiveName });
      }
    } catch (err) {
      await prisma.catalogSyncLog.create({
        data: { centralProductId, establishmentId: estab.id, action: "CREATE", status: "FAILED", error: err.message, triggeredBy },
      });
      results.push({ estabId: estab.id, status: "FAILED", error: err.message });
    }
  }

  const ok     = results.filter(r => r.status !== "FAILED").length;
  const failed = results.filter(r => r.status === "FAILED").length;
  logger.info(`[Sync] ${central.name} — ${ok} sites OK, ${failed} échecs`);
  return { productId: central.id, name: central.name, results, ok, failed };
}

/**
 * Synchronise TOUT le catalogue central vers un établissement spécifique.
 * Utilisé à l'ouverture d'un nouveau site.
 */
export async function syncFullCatalogToSite(groupId, establishmentId, triggeredBy = null) {
  logger.info(`[Sync] Catalogue complet → établissement ${establishmentId}`);

  const products = await prisma.centralProduct.findMany({
    where: { groupId, isPropagated: true, active: true },
    select: { id: true },
  });

  const results = [];
  for (const { id } of products) {
    const r = await syncProductToAllSites(id, triggeredBy);
    results.push(r);
    // Petite pause pour ne pas surcharger la DB
    await new Promise(res => setTimeout(res, 50));
  }

  logger.info(`[Sync] Catalogue complet terminé — ${products.length} produits`);
  return { establishmentId, productCount: products.length, results };
}

/**
 * Applique une règle de prix groupe à tous les établissements.
 * Ex: Promotion -10% sur la catégorie Boissons du 1er au 7 juillet
 */
export async function applyPricingRule(ruleId) {
  const rule = await prisma.pricingRule.findUnique({
    where:   { id: ruleId },
    include: { group: { include: { establishments: true } } },
  });

  if (!rule || !rule.active) throw new Error("Règle introuvable ou inactive");

  logger.info(`[Pricing] Application règle "${rule.name}" — ${rule.type} ${rule.value}%`);

  let affectedCount = 0;

  for (const estab of rule.group.establishments) {
    const products = await prisma.product.findMany({
      where: {
        establishmentId: estab.id,
        active: true,
        ...(rule.scope !== "all" ? { categoryId: rule.scope } : {}),
      },
    });

    for (const product of products) {
      let newPrice = parseFloat(product.price);
      switch (rule.type) {
        case "PERCENT_DISCOUNT":  newPrice *= (1 - parseFloat(rule.value) / 100); break;
        case "PERCENT_INCREASE":  newPrice *= (1 + parseFloat(rule.value) / 100); break;
        case "FIXED_DISCOUNT":    newPrice -= parseFloat(rule.value); break;
      }
      newPrice = Math.max(0.01, r2(newPrice));

      await prisma.product.update({
        where: { id: product.id },
        data:  { price: newPrice },
      });
      affectedCount++;
    }
  }

  logger.info(`[Pricing] ${affectedCount} produits mis à jour`);
  return { ruleId, ruleName: rule.name, affectedCount };
}

// ─── DASHBOARD TEMPS RÉEL ────────────────────────────────────────

/**
 * Snapshot temps réel de tous les établissements du groupe.
 * Utilisé pour le live dashboard (refresh toutes les 30s).
 */
export async function getLiveDashboard(groupId) {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);

  const establishments = await prisma.establishment.findMany({
    where: { groupId },
    select: { id: true, name: true, city: true },
  });

  const snapshots = await Promise.all(establishments.map(async estab => {
    const [tickets, openTables, alerts, lastTicket] = await Promise.all([
      prisma.ticket.findMany({
        where: { establishmentId: estab.id, status: "PAID", createdAt: { gte: start } },
        select: { finalAmount: true },
      }),
      prisma.table.count({
        where: { establishmentId: estab.id, status: "OCCUPIED" },
      }),
      prisma.product.count({
        where: {
          establishmentId: estab.id,
          stockEnabled: true,
          stockAlert:   { not: null },
        },
      }),
      prisma.ticket.findFirst({
        where: { establishmentId: estab.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    const ca     = tickets.reduce((s, t) => s + parseFloat(t.finalAmount), 0);
    const count  = tickets.length;

    return {
      id:           estab.id,
      name:         estab.name,
      city:         estab.city,
      caToday:      r2(ca),
      ticketsToday: count,
      avgBasket:    count > 0 ? r2(ca / count) : 0,
      openTables,
      stockAlerts:  alerts,
      lastTicketAt: lastTicket?.createdAt || null,
      status:       (lastTicket?.createdAt && (now - lastTicket.createdAt < 10 * 60 * 1000)) ? "online" : "idle",
    };
  }));

  const groupTotal = {
    caToday:      r2(snapshots.reduce((s, e) => s + e.caToday, 0)),
    ticketsToday: snapshots.reduce((s, e) => s + e.ticketsToday, 0),
    openTables:   snapshots.reduce((s, e) => s + e.openTables, 0),
    stockAlerts:  snapshots.reduce((s, e) => s + e.stockAlerts, 0),
    onlineSites:  snapshots.filter(e => e.status === "online").length,
    idleSites:    snapshots.filter(e => e.status === "idle").length,
    totalSites:   snapshots.length,
  };

  return { groupId, asOf: now, group: groupTotal, sites: snapshots };
}

// ─── BROADCAST ────────────────────────────────────────────────────

/**
 * Envoie un message à tous les établissements du groupe.
 * Affiché dans l'interface caisse de chaque site.
 */
export async function sendBroadcast(groupId, senderId, { title, body, type, targetSites, expiresAt }) {
  const msg = await prisma.broadcastMessage.create({
    data: {
      groupId, senderId, title, body,
      type:        type || "INFO",
      targetSites: targetSites || null,
      expiresAt:   expiresAt ? new Date(expiresAt) : null,
    },
  });

  logger.info(`[Broadcast] "${title}" → ${targetSites ? targetSites.length + " sites" : "tous"}`);

  // TODO: Émettre via Socket.IO à tous les sites concernés
  // io.to(`group:${groupId}`).emit("broadcast", msg);

  return msg;
}

const r2 = n => Math.round(parseFloat(n) * 100) / 100;
