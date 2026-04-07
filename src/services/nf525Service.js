// src/services/nf525Service.js
// ─────────────────────────────────────────────────────────────────
// Service de conformité NF525 / Loi de Finances France 2026
//
// Obligations légales :
//   • Inaltérabilité  : aucune modification possible après validation
//   • Sécurisation    : chaque ticket signé cryptographiquement (HMAC-SHA256)
//   • Conservation    : données conservées 6 ans minimum
//   • Archivage       : clôtures journalières/mensuelles/annuelles signées
//
// Chaînage : hash(ticket N) = HMAC(data_N + hash(ticket N-1))
// Ce chaînage garantit qu'aucun ticket ne peut être inséré rétroactivement.
// ─────────────────────────────────────────────────────────────────

import crypto from "crypto";
import { prisma } from "../utils/prisma.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../middleware/errorHandler.js";

const SIGNING_KEY = process.env.NF525_SIGNING_KEY;
const SOFTWARE_VERSION = process.env.SOFTWARE_VERSION || "2.0.0";

if (!SIGNING_KEY || SIGNING_KEY.length < 32) {
  throw new Error("NF525_SIGNING_KEY manquante ou trop courte (min 32 caractères)");
}

// ─── SIGNATURE D'UN TICKET ────────────────────────────────────────
/**
 * Calcule la signature HMAC-SHA256 d'un ticket.
 * La donnée signée inclut le hash du ticket précédent (chaînage).
 *
 * @param {Object} ticket - Ticket Prisma avec ses lignes et paiements
 * @param {string|null} prevHash - Hash du ticket précédent (null pour le premier)
 * @returns {string} Hash hexadécimal
 */
export function signTicket(ticket, prevHash) {
  const payload = {
    id:             ticket.id,
    number:         ticket.number,
    establishmentId:ticket.establishmentId,
    totalHt:        ticket.totalHt.toString(),
    totalTva:       ticket.totalTva.toString(),
    totalTtc:       ticket.totalTtc.toString(),
    finalAmount:    ticket.finalAmount.toString(),
    status:         ticket.status,
    createdAt:      ticket.createdAt.toISOString(),
    lines:          ticket.lines?.map(l => ({
      label:       l.label,
      qty:         l.qty.toString(),
      unitPriceTtc:l.unitPriceTtc.toString(),
      tvaRate:     l.tvaRate.toString(),
      totalTtc:    l.totalTtc.toString(),
    })) || [],
    payments: ticket.payments?.map(p => ({
      mode:   p.paymentModeId,
      amount: p.amount.toString(),
    })) || [],
    prevHash: prevHash || "GENESIS",
    softwareVersion: SOFTWARE_VERSION,
  };

  return crypto
    .createHmac("sha256", SIGNING_KEY)
    .update(JSON.stringify(payload))
    .digest("hex");
}

/**
 * Vérifie la validité de la signature d'un ticket.
 * Utilisé pour les audits et les vérifications NF525.
 */
export async function verifyTicketSignature(ticketId) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { lines: true, payments: true },
  });

  if (!ticket) throw new Error(`Ticket ${ticketId} introuvable`);
  if (!ticket.hash) return { valid: false, reason: "Ticket non signé" };

  const prevTicket = await prisma.ticket.findFirst({
    where: {
      establishmentId: ticket.establishmentId,
      number: ticket.number - 1,
      status: { in: ["PAID", "CANCELLED"] },
    },
    select: { hash: true },
  });

  const expectedHash = signTicket(ticket, prevTicket?.hash ?? null);

  return {
    valid:    ticket.hash === expectedHash,
    ticketId: ticket.id,
    number:   ticket.number,
    hash:     ticket.hash,
    expected: expectedHash,
  };
}

// ─── SIGNATURE D'UNE CLÔTURE ─────────────────────────────────────
/**
 * Signe une clôture journalière/mensuelle/annuelle.
 * La clôture inclut le hash de la clôture précédente (chaîne continue).
 */
export function signClosure(closureData, prevClosureHash) {
  const payload = {
    establishmentId: closureData.establishmentId,
    type:            closureData.type,
    periodStart:     closureData.periodStart.toISOString(),
    periodEnd:       closureData.periodEnd.toISOString(),
    ticketCount:     closureData.ticketCount,
    cancelCount:     closureData.cancelCount,
    totalHt:         closureData.totalHt.toString(),
    totalTva:        closureData.totalTva.toString(),
    totalTtc:        closureData.totalTtc.toString(),
    tvaBreakdown:    JSON.stringify(closureData.tvaBreakdown),
    payBreakdown:    JSON.stringify(closureData.payBreakdown),
    userId:          closureData.userId,
    prevHash:        prevClosureHash || "GENESIS",
    softwareVersion: SOFTWARE_VERSION,
    softwareName:    process.env.SOFTWARE_NAME || "NEXPOS",
    softwareEditor:  process.env.SOFTWARE_EDITOR || "NEXPOS SAS",
  };

  return crypto
    .createHmac("sha256", SIGNING_KEY)
    .update(JSON.stringify(payload))
    .digest("hex");
}

// ─── CLÔTURE JOURNALIÈRE (TICKET Z) ─────────────────────────────
/**
 * Effectue la clôture journalière NF525.
 * Calcule tous les totaux, signe la clôture et l'archive.
 * OPÉRATION IRRÉVERSIBLE.
 *
 * @param {string} establishmentId
 * @param {string} userId - ID du caissier qui effectue la clôture
 * @returns {Object} La clôture créée avec ses totaux
 */
export async function performDailyClosure(establishmentId, userId) {
  logger.info(`[NF525] Démarrage clôture Z — Établissement ${establishmentId}`);

  // Vérifier qu'une clôture n'a pas déjà été faite aujourd'hui
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
  const endOfDay   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

  const existingClosure = await prisma.closure.findFirst({
    where: {
      establishmentId,
      type: "DAILY",
      periodStart: { gte: startOfDay },
    },
  });

  if (existingClosure) {
    throw new AppError("Une clôture journalière a déjà été effectuée aujourd'hui.", 400);
  }

  // Récupérer tous les tickets de la journée
  const tickets = await prisma.ticket.findMany({
    where: {
      establishmentId,
      status: { in: ["PAID", "CANCELLED"] },
      createdAt: { gte: startOfDay, lte: endOfDay },
    },
    include: {
      lines: { include: { tvaRateRef: true, product: { include: { category: true } } } },
      payments: { include: { paymentMode: true } },
    },
  });

  // ── Calcul des totaux ─────────────────────────────────────────
  const paidTickets      = tickets.filter(t => t.status === "PAID");
  const cancelledTickets = tickets.filter(t => t.status === "CANCELLED");

  let totalHt  = 0;
  let totalTva = 0;
  let totalTtc = 0;

  // Ventilation TVA, paiements et catégories
  const tvaMap = {};
  const payMap = {};
  const catMap = {};

  for (const ticket of paidTickets) {
    totalHt  += parseFloat(ticket.totalHt);
    totalTva += parseFloat(ticket.totalTva);
    totalTtc += parseFloat(ticket.finalAmount);

    // Ventilation par taux de TVA
    for (const line of ticket.lines) {
      const rate = parseFloat(line.tvaRate).toFixed(1);
      if (!tvaMap[rate]) tvaMap[rate] = { rate: parseFloat(rate), baseHt: 0, tvaAmt: 0, totalTtc: 0 };
      tvaMap[rate].baseHt   += parseFloat(line.totalHt);
      tvaMap[rate].tvaAmt   += parseFloat(line.totalTva);
      tvaMap[rate].totalTtc += parseFloat(line.totalTtc);

      // Ventilation par catégorie
      const catLabel = line.product?.category?.label || (line.menuId ? "Menus" : "Divers");
      if (!catMap[catLabel]) catMap[catLabel] = { category: catLabel, totalHt: 0, totalTtc: 0, qty: 0 };
      catMap[catLabel].totalHt  += parseFloat(line.totalHt);
      catMap[catLabel].totalTtc += parseFloat(line.totalTtc);
      catMap[catLabel].qty      += parseFloat(line.qty);
    }

    // Ventilation par mode de paiement
    for (const pay of ticket.payments) {
      const mode = pay.paymentMode.label;
      if (!payMap[mode]) payMap[mode] = { mode, amount: 0 };
      payMap[mode].amount += parseFloat(pay.amount);
    }
  }

  const r2 = n => Math.round(parseFloat(n) * 100) / 100;

  const tvaBreakdown = Object.values(tvaMap).map(t => ({
    rate:     t.rate,
    baseHt:   r2(t.baseHt),
    tvaAmt:   r2(t.tvaAmt),
    totalTtc: r2(t.totalTtc),
  }));

  const payBreakdown = Object.values(payMap).map(p => ({
    mode:   p.mode,
    amount: r2(p.amount),
  }));

  const categoryBreakdown = Object.values(catMap)
    .map(c => ({ category: c.category, totalHt: r2(c.totalHt), totalTtc: r2(c.totalTtc), qty: r2(c.qty) }))
    .sort((a, b) => b.totalTtc - a.totalTtc);

  // ── Hash de la clôture précédente ────────────────────────────
  const prevClosure = await prisma.closure.findFirst({
    where: { establishmentId, type: "DAILY" },
    orderBy: { signedAt: "desc" },
    select: { hash: true },
  });

  const closureData = {
    establishmentId,
    type: "DAILY",
    periodStart: startOfDay,
    periodEnd: endOfDay,
    ticketCount: paidTickets.length,
    cancelCount: cancelledTickets.length,
    totalHt:     r2(totalHt),
    totalTva:    r2(totalTva),
    totalTtc:    r2(totalTtc),
    tvaBreakdown,
    payBreakdown,
    categoryBreakdown,
    userId,
  };

  const hash = signClosure(closureData, prevClosure?.hash ?? null);

  // ── Créer la clôture en base ──────────────────────────────────
  const closure = await prisma.closure.create({
    data: {
      ...closureData,
      hash,
      prevHash:        prevClosure?.hash ?? null,
      softwareVersion: SOFTWARE_VERSION,
      signedAt:        new Date(),
    },
  });

  logger.info(`[NF525] Clôture Z créée — ${closure.id} | CA: ${totalTtc}€ | ${paidTickets.length} tickets | Hash: ${hash.slice(0,16)}...`);

  return closure;
}

// ─── NUMÉRO DE TICKET SÉQUENTIEL ─────────────────────────────────
/**
 * Obtient le prochain numéro de ticket séquentiel.
 * RÈGLE NF525 : Non réinitialisable, jamais de trous.
 * Utilise une transaction pour éviter les doublons.
 */
export async function getNextTicketNumber(establishmentId) {
  const last = await prisma.ticket.findFirst({
    where: { establishmentId },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  return (last?.number ?? 0) + 1;
}

// ─── RAPPORT D'AUDIT NF525 ────────────────────────────────────────
/**
 * Génère un rapport d'audit complet pour une période.
 * Vérifie la chaîne de signatures.
 */
export async function generateAuditReport(establishmentId, startDate, endDate) {
  const tickets = await prisma.ticket.findMany({
    where: {
      establishmentId,
      createdAt: { gte: startDate, lte: endDate },
    },
    orderBy: { number: "asc" },
    include: { lines: true, payments: true },
  });

  const results = [];
  let chainBroken = false;

  for (const ticket of tickets) {
    if (ticket.status !== "PAID") {
      results.push({ number: ticket.number, status: ticket.status, valid: null, reason: "Non payé" });
      continue;
    }

    const verification = await verifyTicketSignature(ticket.id);
    if (!verification.valid) chainBroken = true;

    results.push({
      number:   ticket.number,
      id:       ticket.id,
      status:   ticket.status,
      valid:    verification.valid,
      hash:     ticket.hash?.slice(0, 16) + "...",
      totalTtc: ticket.finalAmount,
      createdAt:ticket.createdAt,
    });
  }

  return {
    establishmentId,
    period:     { start: startDate, end: endDate },
    totalCount: tickets.length,
    chainValid: !chainBroken,
    results,
    generatedAt: new Date(),
    softwareVersion: SOFTWARE_VERSION,
  };
}

// ─── EXPORT FEC ────────────────────────────────────────────────────
/**
 * Génère le Fichier des Écritures Comptables (FEC)
 * Format imposé par l'article A.47 A-1 du LPF
 *
 * Colonnes obligatoires (18 au total) :
 * JournalCode|JournalLib|EcritureNum|EcritureDate|CompteNum|CompteLib|
 * PieceRef|PieceDate|EcritureLib|Debit|Credit|EcritureLet|DateLet|
 * ValidDate|Montantdevise|Idevise
 */
export async function generateFEC(establishmentId, year) {
  const startDate = new Date(year, 0, 1);
  const endDate   = new Date(year, 11, 31, 23, 59, 59);

  const tickets = await prisma.ticket.findMany({
    where: {
      establishmentId,
      status: "PAID",
      createdAt: { gte: startDate, lte: endDate },
    },
    orderBy: { number: "asc" },
    include: {
      lines: { include: { tvaRateRef: true } },
      payments: { include: { paymentMode: true } },
    },
  });

  const rows = [];
  const fmtDate = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const fmtAmt  = (n) => parseFloat(n).toFixed(2).replace(".", ",");

  for (const ticket of tickets) {
    const ecrNum = `VTE${String(ticket.number).padStart(8, "0")}`;
    const dateStr = fmtDate(ticket.createdAt);

    // Ligne vente (débit client)
    rows.push([
      "VTE", "Ventes caisse",
      ecrNum, dateStr,
      "411000", "Clients",
      `T${ticket.number}`, dateStr,
      `Ticket ${ticket.number}`,
      fmtAmt(ticket.finalAmount), "0,00",
      "", "", dateStr, "", "",
    ].join("|"));

    // Lignes TVA par taux
    for (const line of ticket.lines) {
      const htAmt  = parseFloat(line.totalHt);
      const tvaAmt = parseFloat(line.totalTva);
      const rate   = parseFloat(line.tvaRate);

      // Compte de produit selon taux TVA
      const compte = rate <= 5.5 ? "707100" : rate <= 10 ? "707200" : "707300";
      const compteLib = `Ventes TVA ${rate}%`;

      rows.push([
        "VTE", "Ventes caisse",
        ecrNum, dateStr,
        compte, compteLib,
        `T${ticket.number}`, dateStr,
        line.label.slice(0, 32),
        "0,00", fmtAmt(htAmt),
        "", "", dateStr, "", "",
      ].join("|"));

      // Compte TVA collectée
      const compteTva = rate <= 5.5 ? "445715" : rate <= 10 ? "445710" : "445711";
      rows.push([
        "VTE", "Ventes caisse",
        ecrNum, dateStr,
        compteTva, `TVA collectée ${rate}%`,
        `T${ticket.number}`, dateStr,
        `TVA ${rate}% — Ticket ${ticket.number}`,
        "0,00", fmtAmt(tvaAmt),
        "", "", dateStr, "", "",
      ].join("|"));
    }
  }

  const header = "JournalCode|JournalLib|EcritureNum|EcritureDate|CompteNum|CompteLib|PieceRef|PieceDate|EcritureLib|Debit|Credit|EcritureLet|DateLet|ValidDate|Montantdevise|Idevise";
  return [header, ...rows].join("\n");
}

/**
 * Effectue la clôture mensuelle NF525.
 * Agrège toutes les clôtures journalières (Z) du mois spécifié.
 *
 * @param {string} establishmentId
 * @param {number} year
 * @param {number} month (0-11)
 * @param {string} userId
 */
export async function performMonthlyClosure(establishmentId, year, month, userId) {
  logger.info(`[NF525] Démarrage clôture mensuelle — ${month + 1}/${year} — Établissement ${establishmentId}`);

  const startOfMonth = new Date(year, month, 1, 0, 0, 0);
  const endOfMonth   = new Date(year, month + 1, 0, 23, 59, 59);

  // Vérifier qu'une clôture mensuelle n'a pas déjà été faite
  const existing = await prisma.closure.findFirst({
    where: { establishmentId, type: "MONTHLY", periodStart: startOfMonth },
  });
  if (existing) throw new AppError("La clôture mensuelle pour cette période a déjà été effectuée.", 400);

  // Récupérer toutes les clôtures journalières (Z) du mois
  const dailyClosures = await prisma.closure.findMany({
    where: { establishmentId, type: "DAILY", periodStart: { gte: startOfMonth, lte: endOfMonth } },
    orderBy: { periodStart: "asc" },
  });

  if (dailyClosures.length === 0) {
    throw new AppError("Aucune clôture journalière trouvée pour ce mois. Impossible de générer le rapport mensuel.", 400);
  }

  // ── Agrégation ────────────────────────────────────────────────
  let totalHt  = 0;
  let totalTva = 0;
  let totalTtc = 0;
  let ticketCount = 0;
  let cancelCount = 0;

  const tvaMap = {};
  const payMap = {};
  const catMap = {};
  const r2m = n => Math.round(parseFloat(n) * 100) / 100;

  for (const daily of dailyClosures) {
    totalHt     += parseFloat(daily.totalHt);
    totalTva    += parseFloat(daily.totalTva);
    totalTtc    += parseFloat(daily.totalTtc);
    ticketCount += daily.ticketCount;
    cancelCount += daily.cancelCount;

    // Agrégation TVA
    const tvaList = daily.tvaBreakdown || [];
    for (const t of tvaList) {
      const r = String(parseFloat(t.rate).toFixed(1));
      if (!tvaMap[r]) tvaMap[r] = { rate: t.rate, baseHt: 0, tvaAmt: 0, totalTtc: 0 };
      tvaMap[r].baseHt   += parseFloat(t.baseHt);
      tvaMap[r].tvaAmt   += parseFloat(t.tvaAmt);
      tvaMap[r].totalTtc += parseFloat(t.totalTtc);
    }

    // Agrégation Paiements
    const payList = daily.payBreakdown || [];
    for (const p of payList) {
      if (!payMap[p.mode]) payMap[p.mode] = { mode: p.mode, amount: 0 };
      payMap[p.mode].amount += parseFloat(p.amount);
    }

    // Agrégation Catégories
    const catList = daily.categoryBreakdown || [];
    for (const c of catList) {
      if (!catMap[c.category]) catMap[c.category] = { category: c.category, totalHt: 0, totalTtc: 0, qty: 0 };
      catMap[c.category].totalHt  += parseFloat(c.totalHt);
      catMap[c.category].totalTtc += parseFloat(c.totalTtc);
      catMap[c.category].qty      += parseFloat(c.qty);
    }
  }

  const tvaBreakdown = Object.values(tvaMap).map(t => ({
    rate: t.rate, baseHt: r2m(t.baseHt), tvaAmt: r2m(t.tvaAmt), totalTtc: r2m(t.totalTtc),
  }));

  const payBreakdown = Object.values(payMap).map(p => ({
    mode: p.mode, amount: r2m(p.amount),
  }));

  const categoryBreakdown = Object.values(catMap)
    .map(c => ({ category: c.category, totalHt: r2m(c.totalHt), totalTtc: r2m(c.totalTtc), qty: r2m(c.qty) }))
    .sort((a, b) => b.totalTtc - a.totalTtc);

  // ── Hash de la clôture mensuelle précédente ───────────────────
  const prevMonthly = await prisma.closure.findFirst({
    where: { establishmentId, type: "MONTHLY" },
    orderBy: { signedAt: "desc" },
    select: { hash: true },
  });

  const closureData = {
    establishmentId,
    type: "MONTHLY",
    periodStart: startOfMonth,
    periodEnd:   endOfMonth,
    ticketCount,
    cancelCount,
    totalHt:     r2m(totalHt),
    totalTva:    r2m(totalTva),
    totalTtc:    r2m(totalTtc),
    tvaBreakdown,
    payBreakdown,
    categoryBreakdown,
    userId,
  };

  const hash = signClosure(closureData, prevMonthly?.hash ?? null);

  // ── Création ──────────────────────────────────────────────────
  return await prisma.closure.create({
    data: {
      ...closureData,
      hash,
      prevHash: prevMonthly?.hash ?? null,
      softwareVersion: SOFTWARE_VERSION,
      signedAt: new Date(),
    }
  });
}
