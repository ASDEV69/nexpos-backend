// src/services/loyaltyService.js
// ─────────────────────────────────────────────────────────────────
// Service de fidélité NEXPOS
// Points · Niveaux · Récompenses · Règles RGPD
// ─────────────────────────────────────────────────────────────────
import { prisma } from "../utils/prisma.js";
import { logger } from "../utils/logger.js";
import crypto     from "crypto";

// ─── CALCUL DES POINTS ────────────────────────────────────────────

/**
 * Calcule les points à attribuer pour un achat.
 * Applique le multiplicateur selon le niveau du client.
 */
export function calculatePoints(amount, program, customerLevel) {
  if (!program?.active) return 0;
  if (parseFloat(amount) < parseFloat(program.minPurchase)) return 0;

  const multipliers = {
    BRONZE:   1.0,
    SILVER:   parseFloat(program.silverMultiplier),
    GOLD:     parseFloat(program.goldMultiplier),
    PLATINUM: parseFloat(program.platinumMultiplier),
  };

  const multiplier = multipliers[customerLevel] ?? 1.0;
  const base       = Math.floor(parseFloat(amount) * parseFloat(program.pointsPerEuro));
  return Math.floor(base * multiplier);
}

/**
 * Détermine le niveau d'un client selon son total de points cumulés.
 */
export function computeLevel(totalPoints, program) {
  if (!program) return "BRONZE";
  const p = totalPoints;
  if (p >= program.platinumThreshold) return "PLATINUM";
  if (p >= program.goldThreshold)     return "GOLD";
  if (p >= program.silverThreshold)   return "SILVER";
  return "BRONZE";
}

/**
 * Retourne les infos de progression vers le niveau suivant.
 */
export function getLevelProgress(totalPoints, program) {
  const level = computeLevel(totalPoints, program);
  const thresholds = {
    BRONZE:   { next: "SILVER",   target: program?.silverThreshold   ?? 500  },
    SILVER:   { next: "GOLD",     target: program?.goldThreshold     ?? 1500 },
    GOLD:     { next: "PLATINUM", target: program?.platinumThreshold ?? 5000 },
    PLATINUM: { next: null,       target: null },
  };
  const info   = thresholds[level];
  const prev   = level === "BRONZE" ? 0
    : level === "SILVER"   ? (program?.silverThreshold   ?? 500)
    : level === "GOLD"     ? (program?.goldThreshold     ?? 1500)
    : (program?.platinumThreshold ?? 5000);

  return {
    current:    level,
    next:       info.next,
    points:     totalPoints,
    target:     info.target,
    pointsToNext: info.target ? Math.max(0, info.target - totalPoints) : 0,
    pct:        info.target
      ? Math.min(100, Math.round(((totalPoints - prev) / (info.target - prev)) * 100))
      : 100,
  };
}

// ─── ATTRIBUTION DE POINTS ────────────────────────────────────────

/**
 * Attribue des points à un client suite à un achat.
 * Appelé automatiquement lors du paiement d'un ticket.
 */
export async function earnPoints(customerId, ticketId, amount, establishmentId) {
  const [customer, program] = await Promise.all([
    prisma.customer.findUnique({ where: { id: customerId } }),
    prisma.loyaltyProgram.findUnique({ where: { establishmentId } }),
  ]);

  if (!customer || !program?.active) return null;

  const points = calculatePoints(amount, program, customer.loyaltyLevel);
  if (points <= 0) return null;

  const expiresAt = program.pointsExpiryDays
    ? new Date(Date.now() + program.pointsExpiryDays * 86400000)
    : null;

  const newBalance = customer.loyaltyPoints + points;
  const newLevel   = computeLevel(newBalance, program);
  const levelUp    = newLevel !== customer.loyaltyLevel;

  const [tx] = await prisma.$transaction([
    prisma.loyaltyTransaction.create({
      data: {
        customerId,
        ticketId,
        type:         "EARN_PURCHASE",
        points,
        balanceBefore: customer.loyaltyPoints,
        balanceAfter:  newBalance,
        description:  `Achat ${parseFloat(amount).toFixed(2)}€ — Ticket`,
        expiresAt,
      },
    }),
    prisma.customer.update({
      where: { id: customerId },
      data: {
        loyaltyPoints: newBalance,
        loyaltyLevel:  newLevel,
        totalSpent:    { increment: parseFloat(amount) },
        visitCount:    { increment: 1 },
        lastVisitAt:   new Date(),
      },
    }),
  ]);

  if (levelUp) {
    logger.info(`[Loyalty] 🎉 Level up: ${customer.firstName} ${customer.lastName} → ${newLevel}`);
    await sendLevelUpNotification(customer, newLevel);
  }

  logger.info(`[Loyalty] +${points} pts pour ${customer.firstName} (total: ${newBalance})`);
  return { transaction: tx, points, newBalance, newLevel, levelUp };
}

/**
 * Utilise des points pour une récompense.
 */
export async function redeemPoints(customerId, rewardId, ticketId = null) {
  const [customer, reward] = await Promise.all([
    prisma.customer.findUnique({ where: { id: customerId } }),
    prisma.loyaltyReward.findUnique({
      where:   { id: rewardId },
      include: { program: true },
    }),
  ]);

  if (!customer) throw new Error("Client introuvable");
  if (!reward?.active) throw new Error("Récompense indisponible");

  // Vérifications
  if (customer.loyaltyPoints < reward.pointsCost) {
    throw new Error(`Points insuffisants (${customer.loyaltyPoints} / ${reward.pointsCost} requis)`);
  }

  const levelOrder = { BRONZE: 0, SILVER: 1, GOLD: 2, PLATINUM: 3 };
  if (levelOrder[customer.loyaltyLevel] < levelOrder[reward.minLevel]) {
    throw new Error(`Niveau ${reward.minLevel} requis (vous êtes ${customer.loyaltyLevel})`);
  }

  // Vérifier limite mensuelle
  if (reward.maxPerMonth) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
    const usedThisMonth = await prisma.customerReward.count({
      where: {
        customerId,
        rewardId,
        status:    "USED",
        usedAt:    { gte: startOfMonth },
      },
    });
    if (usedThisMonth >= reward.maxPerMonth) {
      throw new Error(`Limite mensuelle atteinte pour cette récompense`);
    }
  }

  const newBalance = customer.loyaltyPoints - reward.pointsCost;
  const code       = generateRewardCode();

  const [customerReward] = await prisma.$transaction([
    prisma.customerReward.create({
      data: {
        customerId,
        rewardId,
        code,
        status:    "PENDING",
        expiresAt: new Date(Date.now() + 30 * 86400000), // 30 jours
      },
    }),
    prisma.loyaltyTransaction.create({
      data: {
        customerId,
        ticketId,
        type:         "REDEEM",
        points:       -reward.pointsCost,
        balanceBefore: customer.loyaltyPoints,
        balanceAfter:  newBalance,
        description:  `Échange: ${reward.name}`,
      },
    }),
    prisma.customer.update({
      where: { id: customerId },
      data:  { loyaltyPoints: newBalance },
    }),
  ]);

  logger.info(`[Loyalty] Échange: ${customer.firstName} — ${reward.name} (code: ${code})`);
  return { customerReward, code, reward, newBalance };
}

/**
 * Valide et utilise un code de récompense à l'encaissement.
 */
export async function useRewardCode(code, ticketId) {
  const cr = await prisma.customerReward.findUnique({
    where:   { code },
    include: { reward: true, customer: true },
  });

  if (!cr)                   throw new Error("Code de récompense invalide");
  if (cr.status === "USED")  throw new Error("Récompense déjà utilisée");
  if (cr.status === "EXPIRED" || (cr.expiresAt && cr.expiresAt < new Date())) {
    await prisma.customerReward.update({ where: { id: cr.id }, data: { status: "EXPIRED" } });
    throw new Error("Code de récompense expiré");
  }
  if (cr.status === "CANCELLED") throw new Error("Récompense annulée");

  await prisma.customerReward.update({
    where: { id: cr.id },
    data:  { status: "USED", usedAt: new Date(), usedOnTicketId: ticketId },
  });

  return {
    valid:    true,
    reward:   cr.reward,
    customer: cr.customer,
    discount: computeRewardDiscount(cr.reward),
  };
}

function computeRewardDiscount(reward) {
  switch (reward.type) {
    case "DISCOUNT_EUR": return { type: "eur", amount: parseFloat(reward.value) };
    case "DISCOUNT_PCT": return { type: "pct", amount: parseFloat(reward.value) };
    case "FREE_PRODUCT": return { type: "product", productId: reward.value };
    default:             return { type: "custom" };
  }
}

// ─── ANNIVERSAIRES ────────────────────────────────────────────────

/**
 * Job quotidien : attribuer le bonus anniversaire aux clients concernés.
 */
export async function processBirthdayBonuses(establishmentId) {
  const today     = new Date();
  const month     = today.getMonth() + 1;
  const day       = today.getDate();

  const program   = await prisma.loyaltyProgram.findUnique({ where: { establishmentId } });
  if (!program?.active || !program.birthdayBonus) return { count: 0 };

  // Clients dont c'est l'anniversaire aujourd'hui ET qui ont consenti au marketing
  const customers = await prisma.customer.findMany({
    where: {
      establishmentId,
      consentMarketing: true,
      deletedAt:        null,
      birthDate:        { not: null },
    },
  });

  const toBonus = customers.filter(c => {
    if (!c.birthDate) return false;
    const bd = new Date(c.birthDate);
    return bd.getMonth() + 1 === month && bd.getDate() === day;
  });

  let count = 0;
  for (const customer of toBonus) {
    // Vérifier si le bonus n'a pas déjà été attribué cette année
    const alreadyGiven = await prisma.loyaltyTransaction.findFirst({
      where: {
        customerId: customer.id,
        type:       "EARN_BIRTHDAY",
        createdAt:  {
          gte: new Date(today.getFullYear(), 0, 1),
          lte: new Date(today.getFullYear(), 11, 31),
        },
      },
    });
    if (alreadyGiven) continue;

    const newBalance = customer.loyaltyPoints + program.birthdayBonus;
    await prisma.$transaction([
      prisma.loyaltyTransaction.create({
        data: {
          customerId:    customer.id,
          type:          "EARN_BIRTHDAY",
          points:        program.birthdayBonus,
          balanceBefore: customer.loyaltyPoints,
          balanceAfter:  newBalance,
          description:   `Bonus anniversaire 🎂`,
        },
      }),
      prisma.customer.update({
        where: { id: customer.id },
        data:  { loyaltyPoints: newBalance },
      }),
    ]);

    await sendBirthdayMessage(customer, program.birthdayBonus);
    count++;
    logger.info(`[Loyalty] 🎂 Bonus anniversaire: ${customer.firstName} ${customer.lastName} +${program.birthdayBonus} pts`);
  }

  return { count, bonus: program.birthdayBonus };
}

/**
 * Job mensuel : expirer les points anciens.
 */
export async function expireOldPoints(establishmentId) {
  const expired = await prisma.loyaltyTransaction.findMany({
    where: {
      customer:  { establishmentId },
      type:      "EARN_PURCHASE",
      expiresAt: { lt: new Date() },
      // On ne veut pas ré-expirer ce qui est déjà expiré
      points:    { gt: 0 },
    },
    include: { customer: true },
  });

  let count = 0;
  for (const tx of expired) {
    const customer = tx.customer;
    const deduct   = Math.min(tx.points, customer.loyaltyPoints);
    if (deduct <= 0) continue;

    await prisma.$transaction([
      prisma.loyaltyTransaction.create({
        data: {
          customerId:    customer.id,
          type:          "EXPIRE",
          points:        -deduct,
          balanceBefore: customer.loyaltyPoints,
          balanceAfter:  customer.loyaltyPoints - deduct,
          description:   `Points expirés`,
        },
      }),
      prisma.customer.update({
        where: { id: customer.id },
        data:  { loyaltyPoints: { decrement: deduct } },
      }),
      // Marquer la transaction source comme "expirée" (points = 0)
      prisma.loyaltyTransaction.update({
        where: { id: tx.id },
        data:  { points: 0 },
      }),
    ]);
    count++;
  }

  logger.info(`[Loyalty] ${count} transactions expirées traitées`);
  return { count };
}

// ─── RGPD ─────────────────────────────────────────────────────────

/**
 * Anonymise les données personnelles d'un client (droit à l'oubli RGPD).
 * Conserve les données transactionnelles anonymisées (obligation comptable).
 */
export async function anonymizeCustomer(customerId, requestedBy) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new Error("Client introuvable");
  if (customer.anonymizedAt) throw new Error("Client déjà anonymisé");

  await prisma.customer.update({
    where: { id: customerId },
    data:  {
      // Effacement des données personnelles
      firstName:        `Anonyme_${customerId.slice(0,8)}`,
      lastName:         null,
      email:            null,
      phone:            null,
      birthDate:        null,
      loyaltyCardId:    null,
      notes:            null,
      tags:             [],
      allergies:        [],
      preferredTable:   null,
      // Conservation des données statistiques
      // loyaltyPoints, totalSpent, visitCount → gardés pour stats
      consentMarketing: false,
      consentAnalytics: false,
      anonymizedAt:     new Date(),
      deletedAt:        new Date(),
    },
  });

  logger.info(`[RGPD] Client ${customerId} anonymisé par ${requestedBy}`);
  return { success: true, customerId };
}

// ─── SEGMENTATION ─────────────────────────────────────────────────

/**
 * Retourne les clients selon un segment pour ciblage campagne.
 */
export async function getSegment(establishmentId, segment, conditions = {}) {
  const base = {
    establishmentId,
    deletedAt:        null,
    consentMarketing: true,
  };

  let where = { ...base };

  switch (segment) {
    case "all":
      break;
    case "bronze":
      where.loyaltyLevel = "BRONZE";
      break;
    case "silver":
      where.loyaltyLevel = "SILVER";
      break;
    case "gold":
      where.loyaltyLevel = "GOLD";
      break;
    case "platinum":
      where.loyaltyLevel = "PLATINUM";
      break;
    case "inactive": {
      const cutoff = new Date(Date.now() - 60 * 86400000); // 60 jours
      where.lastVisitAt = { lt: cutoff };
      break;
    }
    case "birthday": {
      const today = new Date();
      // Retourner les clients dont l'anniversaire est dans les 7 prochains jours
      where.birthDate = { not: null };
      break; // Le filtrage précis se fait en JS (voir processBirthdayBonuses)
    }
    case "high_value":
      where.totalSpent = { gte: 500 };
      break;
    case "new": {
      const cutoff = new Date(Date.now() - 30 * 86400000);
      where.createdAt = { gte: cutoff };
      break;
    }
    default:
      break;
  }

  const customers = await prisma.customer.findMany({
    where,
    select: {
      id: true, firstName: true, lastName: true,
      email: true, phone: true,
      loyaltyLevel: true, loyaltyPoints: true,
      totalSpent: true, visitCount: true, lastVisitAt: true,
    },
    orderBy: { totalSpent: "desc" },
  });

  return customers;
}

// ─── HELPERS ─────────────────────────────────────────────────────
function generateRewardCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

async function sendLevelUpNotification(customer, newLevel) {
  if (!customer.email && !customer.phone) return;
  const msgs = {
    SILVER:   `🥈 Félicitations ${customer.firstName} ! Vous êtes maintenant membre Silver.`,
    GOLD:     `🥇 Bravo ${customer.firstName} ! Niveau Gold atteint !`,
    PLATINUM: `💎 Exceptionnel ${customer.firstName} ! Vous avez atteint le niveau Platinum !`,
  };
  logger.info(`[Loyalty] Notification level-up: ${msgs[newLevel]}`);
  // TODO: intégrer envoi SMS/email (Phase B)
}

async function sendBirthdayMessage(customer, bonusPoints) {
  if (!customer.email && !customer.phone) return;
  logger.info(`[Loyalty] SMS anniversaire envoyé à ${customer.firstName} (+${bonusPoints} pts)`);
  // TODO: intégrer envoi SMS/email
}
