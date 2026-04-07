// src/routes/customers.js — Routes API CRM & Fidélité
// ─────────────────────────────────────────────────────────────────
import { Router }       from "express";
import { body, param, query, validationResult } from "express-validator";
import { authenticate, requireCashier, requireManager } from "../middleware/auth.js";
import { AppError }     from "../middleware/errorHandler.js";
import { auditLog }     from "../utils/auditLog.js";
import { prisma }       from "../utils/prisma.js";
import {
  earnPoints, redeemPoints, useRewardCode,
  getLevelProgress, anonymizeCustomer,
  getSegment, processBirthdayBonuses,
} from "../services/loyaltyService.js";
import {
  sendCampaign, estimateCampaignReach,
} from "../services/campaignService.js";

const router = Router();
router.use(authenticate);

// ════════════════════════════════════════════════════════════════
// CLIENTS
// ════════════════════════════════════════════════════════════════

// Rechercher / lister
router.get("/", requireCashier, async (req, res, next) => {
  try {
    const { q, level, page = 1, limit = 50, segment } = req.query;
    const eid = req.establishmentId;

    if (segment) {
      const customers = await getSegment(eid, segment);
      return res.json({ customers, total: customers.length });
    }

    const where = {
      establishmentId: eid,
      deletedAt: null,
      ...(level ? { loyaltyLevel: level } : {}),
      ...(q ? {
        OR: [
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName:  { contains: q, mode: "insensitive" } },
          { email:     { contains: q, mode: "insensitive" } },
          { phone:     { contains: q } },
          { loyaltyCardId: { contains: q } },
        ],
      } : {}),
    };

    const [customers, total] = await prisma.$transaction([
      prisma.customer.findMany({
        where,
        orderBy: { lastVisitAt: "desc" },
        skip:  (parseInt(page) - 1) * parseInt(limit),
        take:  parseInt(limit),
        select: {
          id: true, firstName: true, lastName: true,
          email: true, phone: true, address: true, loyaltyCardId: true,
          loyaltyPoints: true, loyaltyLevel: true,
          totalSpent: true, visitCount: true, lastVisitAt: true,
          tags: true, createdAt: true,
        },
      }),
      prisma.customer.count({ where }),
    ]);

    res.json({ customers, total, page: parseInt(page) });
  } catch (err) { next(err); }
});

// Créer un client
router.post("/",
  requireCashier,
  body("firstName").optional().trim(),
  body("lastName").optional().trim(),
  body("email").optional().isEmail().normalizeEmail(),
  body("phone").optional().trim(),
  body("address").optional().trim(),
  body("consentMarketing").optional().isBoolean(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);

      const { consentMarketing = false, consentAnalytics = false, ...data } = req.body;

      // Générer un ID de carte fidélité
      const loyaltyCardId = generateCardId();

      const customer = await prisma.customer.create({
        data: {
          ...data,
          establishmentId:  req.establishmentId,
          loyaltyCardId,
          consentMarketing,
          consentAnalytics,
          consentDate: (consentMarketing || consentAnalytics) ? new Date() : null,
          consentIp:   (consentMarketing || consentAnalytics) ? req.ip : null,
          source:      data.source || "CASHIER",
        },
      });

      await auditLog({
        establishmentId: req.establishmentId,
        userId: req.user.id,
        action: "CREATE_CUSTOMER",
        entity: "customer",
        entityId: customer.id,
      });

      res.status(201).json(customer);
    } catch (err) {
      if (err.code === "P2002") return next(new AppError("Email ou téléphone déjà utilisé", 409));
      next(err);
    }
  }
);

// Détail client + solde fidélité
router.get("/:id", requireCashier, param("id").isUUID(), async (req, res, next) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, establishmentId: req.establishmentId, deletedAt: null },
      include: {
        transactions: { orderBy: { createdAt: "desc" }, take: 20 },
        rewards:      { where: { status: "PENDING" }, include: { reward: true } },
      },
    });
    if (!customer) throw new AppError("Client introuvable", 404);

    const program  = await prisma.loyaltyProgram.findUnique({ where: { establishmentId: req.establishmentId } });
    const progress = getLevelProgress(customer.loyaltyPoints, program);

    res.json({ ...customer, loyaltyProgress: progress });
  } catch (err) { next(err); }
});

// Mettre à jour
router.put("/:id", requireCashier, param("id").isUUID(), async (req, res, next) => {
  try {
    const exists = await prisma.customer.findFirst({ where: { id: req.params.id, establishmentId: req.establishmentId } });
    if (!exists) throw new AppError("Client introuvable", 404);

    const customer = await prisma.customer.update({
      where: { id: req.params.id },
      data:  req.body,
    });
    res.json(customer);
  } catch (err) { next(err); }
});

// Supprimer (soft delete)
router.delete("/:id", requireManager, param("id").isUUID(), async (req, res, next) => {
  try {
    const exists = await prisma.customer.findFirst({ where: { id: req.params.id, establishmentId: req.establishmentId } });
    if (!exists) throw new AppError("Client introuvable", 404);

    await prisma.customer.update({
      where: { id: req.params.id },
      data:  { deletedAt: new Date() },
    });

    await auditLog({
      establishmentId: req.establishmentId,
      userId:   req.user.id,
      action:   "DELETE_CUSTOMER",
      entity:   "customer",
      entityId: req.params.id,
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});


// Recherche par numéro de carte fidélité
router.get("/card/:cardId", requireCashier, async (req, res, next) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { loyaltyCardId: req.params.cardId, establishmentId: req.establishmentId, deletedAt: null },
      include: { rewards: { where: { status: "PENDING" }, include: { reward: true } } },
    });
    if (!customer) throw new AppError("Carte fidélité introuvable", 404);

    const program  = await prisma.loyaltyProgram.findUnique({ where: { establishmentId: req.establishmentId } });
    const progress = getLevelProgress(customer.loyaltyPoints, program);
    res.json({ ...customer, loyaltyProgress: progress });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// FIDÉLITÉ
// ════════════════════════════════════════════════════════════════

// Attribuer des points manuellement
router.post("/:id/earn",
  requireCashier,
  body("amount").isFloat({ min: 0.01 }),
  async (req, res, next) => {
    try {
      const result = await earnPoints(req.params.id, null, req.body.amount, req.establishmentId);
      res.json(result || { message: "Programme fidélité inactif" });
    } catch (err) { next(err); }
});

// Échanger des points contre une récompense
router.post("/:id/redeem",
  requireCashier,
  body("rewardId").isUUID(),
  async (req, res, next) => {
    try {
      const result = await redeemPoints(req.params.id, req.body.rewardId, req.body.ticketId);
      res.json(result);
    } catch (err) {
      if (err.message.includes("Points insuffisants") || err.message.includes("Niveau")) {
        return next(new AppError(err.message, 422));
      }
      next(err);
    }
});

// Valider un code de récompense à l'encaissement
router.post("/rewards/use",
  requireCashier,
  body("code").notEmpty(),
  async (req, res, next) => {
    try {
      const result = await useRewardCode(req.body.code, req.body.ticketId);
      res.json(result);
    } catch (err) {
      next(new AppError(err.message, 422));
    }
});

// Historique des transactions fidélité
router.get("/:id/transactions", requireCashier, async (req, res, next) => {
  try {
    const txs = await prisma.loyaltyTransaction.findMany({
      where:   { customerId: req.params.id },
      orderBy: { createdAt: "desc" },
      take:    100,
    });
    res.json(txs);
  } catch (err) { next(err); }
});

// Programme fidélité de l'établissement
router.get("/program/config", requireCashier, async (req, res, next) => {
  try {
    const program = await prisma.loyaltyProgram.findUnique({
      where:   { establishmentId: req.establishmentId },
      include: { rewards: { where: { active: true }, orderBy: { pointsCost: "asc" } } },
    });
    res.json(program);
  } catch (err) { next(err); }
});

// Configurer le programme fidélité
router.put("/program/config", requireManager, async (req, res, next) => {
  try {
    const program = await prisma.loyaltyProgram.upsert({
      where:  { establishmentId: req.establishmentId },
      update: req.body,
      create: { ...req.body, establishmentId: req.establishmentId },
      include: { rewards: true },
    });
    res.json(program);
  } catch (err) { next(err); }
});


// Ajouter une récompense
router.post("/program/rewards", requireManager, async (req, res, next) => {
  try {
    const program = await prisma.loyaltyProgram.findUnique({ where: { establishmentId: req.establishmentId } });
    if (!program) throw new AppError("Programme fidélité inexistant", 404);

    const reward = await prisma.loyaltyReward.create({
      data: { ...req.body, programId: program.id },
    });
    res.status(201).json(reward);
  } catch (err) { next(err); }
});

// Modifier une récompense
router.put("/program/rewards/:id", requireManager, param("id").isUUID(), async (req, res, next) => {
  try {
    const reward = await prisma.loyaltyReward.update({
      where: { id: req.params.id },
      data:  req.body,
    });
    res.json(reward);
  } catch (err) { next(err); }
});

// Supprimer une récompense (logic delete)
router.delete("/program/rewards/:id", requireManager, param("id").isUUID(), async (req, res, next) => {
  try {
    await prisma.loyaltyReward.update({
      where: { id: req.params.id },
      data:  { active: false },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});


// Récompenses disponibles pour un client
router.get("/:id/available-rewards", requireCashier, async (req, res, next) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) throw new AppError("Client introuvable", 404);

    const program = await prisma.loyaltyProgram.findUnique({
      where:   { establishmentId: req.establishmentId },
      include: { rewards: { where: { active: true } } },
    });

    const levelOrder = { BRONZE: 0, SILVER: 1, GOLD: 2, PLATINUM: 3 };
    const available  = (program?.rewards || []).filter(r =>
      r.pointsCost <= customer.loyaltyPoints &&
      levelOrder[customer.loyaltyLevel] >= levelOrder[r.minLevel] &&
      (!r.validUntil || r.validUntil > new Date())
    );

    res.json(available);
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// CAMPAGNES
// ════════════════════════════════════════════════════════════════

router.get("/campaigns/list", requireManager, async (req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where:   { establishmentId: req.establishmentId },
      orderBy: { createdAt: "desc" },
    });
    res.json(campaigns);
  } catch (err) { next(err); }
});

router.post("/campaigns",
  requireManager,
  body("name").notEmpty(),
  body("type").isIn(["EMAIL","SMS","PUSH"]),
  body("bodyText").notEmpty(),
  body("targetSegment").optional(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);

      const reach = await estimateCampaignReach(
        req.establishmentId,
        req.body.targetSegment || "all",
        req.body.type
      );

      const campaign = await prisma.campaign.create({
        data: { ...req.body, establishmentId: req.establishmentId, estimatedReach: reach.reachable },
      });
      res.status(201).json({ ...campaign, estimatedReach: reach });
    } catch (err) { next(err); }
});

router.get("/campaigns/:id/estimate", requireManager, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, establishmentId: req.establishmentId } });
    if (!campaign) throw new AppError("Campagne introuvable", 404);
    const reach = await estimateCampaignReach(req.establishmentId, campaign.targetSegment, campaign.type);
    res.json(reach);
  } catch (err) { next(err); }
});

router.post("/campaigns/:id/send", requireManager, async (req, res, next) => {
  try {
    const result = await sendCampaign(req.params.id);
    res.json(result);
  } catch (err) { next(new AppError(err.message, 422)); }
});

router.get("/campaigns/:id/stats", requireManager, async (req, res, next) => {
  try {
    const [campaign, logs] = await Promise.all([
      prisma.campaign.findFirst({ where: { id: req.params.id, establishmentId: req.establishmentId } }),
      prisma.campaignLog.groupBy({
        by: ["status"],
        where: { campaignId: req.params.id },
        _count: true,
      }),
    ]);
    if (!campaign) throw new AppError("Campagne introuvable", 404);
    const stats = logs.reduce((acc, l) => { acc[l.status] = l._count; return acc; }, {});
    res.json({ ...campaign, statusBreakdown: stats });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// RGPD
// ════════════════════════════════════════════════════════════════

// Droit d'accès (retourne toutes les données du client)
router.get("/:id/gdpr/export", requireManager, async (req, res, next) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, establishmentId: req.establishmentId },
      include: { transactions: true, rewards: true, campaignLogs: true },
    });
    if (!customer) throw new AppError("Client introuvable", 404);

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="client_${req.params.id}_data.json"`);
    res.json({
      exportDate: new Date(),
      customer,
      notice: "Export de données personnelles conformément au RGPD (art. 15)",
    });
  } catch (err) { next(err); }
});

// Droit à l'effacement (anonymisation)
router.delete("/:id/gdpr/erase", requireManager, async (req, res, next) => {
  try {
    const result = await anonymizeCustomer(req.params.id, req.user.id);
    await auditLog({
      establishmentId: req.establishmentId,
      userId:   req.user.id,
      action:   "GDPR_ERASE_CUSTOMER",
      entity:   "customer",
      entityId: req.params.id,
    });
    res.json(result);
  } catch (err) { next(new AppError(err.message, 422)); }
});

// Désabonnement marketing (lien email/SMS)
router.post("/unsubscribe",
  body("token").notEmpty(),
  async (req, res, next) => {
    try {
      const { customerId } = verifyUnsubToken(req.body.token);
      await prisma.customer.update({
        where: { id: customerId },
        data:  { consentMarketing: false },
      });
      res.json({ message: "Désabonnement confirmé. Vous ne recevrez plus de communications marketing." });
    } catch {
      next(new AppError("Lien de désabonnement invalide ou expiré", 400));
    }
});

function verifyUnsubToken(token) {
  // En prod: jwt.verify(token, process.env.JWT_SECRET)
  return { customerId: token }; // Simplifié pour la démo
}

function generateCardId() {
  const num = Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000;
  return `NXP${num}`;
}

export default router;
