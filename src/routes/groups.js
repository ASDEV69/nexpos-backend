// src/routes/groups.js — API REST Multi-site
import { Router } from "express";
import { body, param, query, validationResult } from "express-validator";
import { prisma }       from "../utils/prisma.js";
import { authenticate } from "../middleware/auth.js";
import { AppError }     from "../middleware/errorHandler.js";
import { auditLog }     from "../utils/auditLog.js";
import {
  generateConsolidatedReport,
  syncProductToAllSites,
  syncFullCatalogToSite,
  applyPricingRule,
  getLiveDashboard,
  sendBroadcast,
} from "../services/multisiteService.js";

const router = Router();
router.use(authenticate);

// ── Middleware: vérifier accès groupe ────────────────────────────
async function requireGroupAccess(req, res, next, minRole = "VIEWER") {
  const ORDER = { OWNER: 4, ADMIN: 3, ANALYST: 2, VIEWER: 1 };
  const membership = await prisma.groupUser.findUnique({
    where: { groupId_userId: { groupId: req.params.groupId, userId: req.user.id } },
  });
  if (!membership) return next(new AppError("Accès refusé à ce groupe", 403));
  if (ORDER[membership.role] < ORDER[minRole]) {
    return next(new AppError(`Rôle ${minRole} requis`, 403));
  }
  req.groupRole = membership.role;
  next();
}

const canView  = (req, res, next) => requireGroupAccess(req, res, next, "VIEWER");
const canAdmin = (req, res, next) => requireGroupAccess(req, res, next, "ADMIN");
const canOwn   = (req, res, next) => requireGroupAccess(req, res, next, "OWNER");

// ════════════════════════════════════════════════════════════════
// GROUPES
// ════════════════════════════════════════════════════════════════

// Mes groupes
router.get("/", async (req, res, next) => {
  try {
    const memberships = await prisma.groupUser.findMany({
      where:   { userId: req.user.id },
      include: {
        group: {
          include: {
            _count: { select: { establishments: true, centralCatalog: true } },
          },
        },
      },
    });
    res.json(memberships.map(m => ({
      ...m.group,
      myRole:           m.role,
      establishmentCount: m.group._count.establishments,
      catalogSize:        m.group._count.centralCatalog,
    })));
  } catch (err) { next(err); }
});

// Créer un groupe
router.post("/",
  body("name").notEmpty().trim(),
  body("slug").notEmpty().toLowerCase().trim(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);

      const group = await prisma.$transaction(async tx => {
        const g = await tx.group.create({ data: { name: req.body.name, slug: req.body.slug, logo: req.body.logo } });
        await tx.groupUser.create({ data: { groupId: g.id, userId: req.user.id, role: "OWNER" } });
        return g;
      });

      await auditLog({ establishmentId: req.establishmentId, userId: req.user.id, action: "CREATE_GROUP", entity: "group", entityId: group.id });
      res.status(201).json(group);
    } catch (err) { next(err); }
});

// Détail groupe
router.get("/:groupId", canView, async (req, res, next) => {
  try {
    const group = await prisma.group.findUnique({
      where:   { id: req.params.groupId },
      include: {
        establishments: { select: { id: true, name: true, city: true, active: true } },
        groupUsers:     { select: { userId: true, role: true } },
        _count:         { select: { centralCatalog: true, centralMenus: true } },
      },
    });
    if (!group) throw new AppError("Groupe introuvable", 404);
    res.json({ ...group, myRole: req.groupRole });
  } catch (err) { next(err); }
});

// Ajouter un établissement au groupe
router.post("/:groupId/establishments",
  canAdmin,
  body("establishmentId").isUUID(),
  async (req, res, next) => {
    try {
      const estab = await prisma.establishment.findUnique({ where: { id: req.body.establishmentId } });
      if (!estab) throw new AppError("Établissement introuvable", 404);
      if (estab.groupId) throw new AppError("Établissement déjà dans un groupe", 409);

      await prisma.establishment.update({
        where: { id: req.body.establishmentId },
        data:  { groupId: req.params.groupId },
      });
      res.json({ message: "Établissement ajouté au groupe", establishmentId: estab.id });
    } catch (err) { next(err); }
});

// Gérer les membres du groupe
router.put("/:groupId/members/:userId",
  canOwn,
  body("role").isIn(["ADMIN", "ANALYST", "VIEWER"]),
  async (req, res, next) => {
    try {
      const member = await prisma.groupUser.upsert({
        where:  { groupId_userId: { groupId: req.params.groupId, userId: req.params.userId } },
        update: { role: req.body.role },
        create: { groupId: req.params.groupId, userId: req.params.userId, role: req.body.role },
      });
      res.json(member);
    } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// CATALOGUE CENTRAL
// ════════════════════════════════════════════════════════════════

// Lister le catalogue central
router.get("/:groupId/catalog", canView, async (req, res, next) => {
  try {
    const { categoryId, active = "true" } = req.query;
    const products = await prisma.centralProduct.findMany({
      where: {
        groupId: req.params.groupId,
        ...(categoryId ? { centralCategoryId: categoryId } : {}),
        ...(active !== "all" ? { active: active === "true" } : {}),
      },
      include: { centralCategory: true, _count: { select: { siteOverrides: true } } },
      orderBy: [{ centralCategory: { sortOrder: "asc" } }, { name: "asc" }],
    });
    res.json(products);
  } catch (err) { next(err); }
});

// Créer un produit central
router.post("/:groupId/catalog",
  canAdmin,
  body("name").notEmpty(),
  body("basePrice").isFloat({ min: 0.01 }),
  body("tva").isFloat({ min: 0 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);

      const product = await prisma.centralProduct.create({
        data: { ...req.body, groupId: req.params.groupId },
      });

      // Auto-sync si isPropagated
      if (product.isPropagated) {
        syncProductToAllSites(product.id, req.user.id).catch(err =>
          logger.error("[Catalog] Erreur auto-sync:", err)
        );
      }

      res.status(201).json(product);
    } catch (err) { next(err); }
});

// Mettre à jour un produit central
router.put("/:groupId/catalog/:productId", canAdmin, async (req, res, next) => {
  try {
    const product = await prisma.centralProduct.update({
      where: { id: req.params.productId },
      data:  req.body,
    });

    // Re-sync automatique
    if (product.isPropagated) {
      syncProductToAllSites(product.id, req.user.id).catch(err =>
        logger.error("[Catalog] Erreur re-sync:", err)
      );
    }
    res.json(product);
  } catch (err) { next(err); }
});

// Synchroniser manuellement un produit
router.post("/:groupId/catalog/:productId/sync", canAdmin, async (req, res, next) => {
  try {
    const result = await syncProductToAllSites(req.params.productId, req.user.id);
    res.json(result);
  } catch (err) { next(err); }
});

// Synchroniser tout le catalogue vers un site
router.post("/:groupId/sync/establishment/:estabId", canAdmin, async (req, res, next) => {
  try {
    const result = await syncFullCatalogToSite(req.params.groupId, req.params.estabId, req.user.id);
    res.json(result);
  } catch (err) { next(err); }
});

// Override prix local
router.put("/:groupId/catalog/:productId/override/:estabId",
  canAdmin,
  body("localPrice").optional().isFloat({ min: 0.01 }),
  body("localName").optional().isString(),
  async (req, res, next) => {
    try {
      const override = await prisma.productSiteOverride.upsert({
        where:  { centralProductId_establishmentId: { centralProductId: req.params.productId, establishmentId: req.params.estabId } },
        update: { localPrice: req.body.localPrice || null, localName: req.body.localName || null, active: true },
        create: { centralProductId: req.params.productId, establishmentId: req.params.estabId, localPrice: req.body.localPrice || null, localName: req.body.localName || null },
      });
      res.json(override);
    } catch (err) { next(err); }
});

// Historique de synchronisation
router.get("/:groupId/catalog/:productId/sync-log", canAdmin, async (req, res, next) => {
  try {
    const logs = await prisma.catalogSyncLog.findMany({
      where:   { centralProductId: req.params.productId },
      orderBy: { createdAt: "desc" },
      take:    50,
    });
    res.json(logs);
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// RÈGLES DE PRIX
// ════════════════════════════════════════════════════════════════

router.get("/:groupId/pricing-rules", canView, async (req, res, next) => {
  try {
    const rules = await prisma.pricingRule.findMany({
      where: { groupId: req.params.groupId },
      orderBy: { createdAt: "desc" },
    });
    res.json(rules);
  } catch (err) { next(err); }
});

router.post("/:groupId/pricing-rules",
  canAdmin,
  body("name").notEmpty(),
  body("type").isIn(["PERCENT_DISCOUNT","FIXED_DISCOUNT","PERCENT_INCREASE","HAPPY_HOUR"]),
  body("value").isFloat({ min: 0 }),
  async (req, res, next) => {
    try {
      const rule = await prisma.pricingRule.create({
        data: { ...req.body, groupId: req.params.groupId },
      });
      res.status(201).json(rule);
    } catch (err) { next(err); }
});

router.post("/:groupId/pricing-rules/:ruleId/apply", canAdmin, async (req, res, next) => {
  try {
    const result = await applyPricingRule(req.params.ruleId);
    res.json(result);
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// RAPPORTS CONSOLIDÉS
// ════════════════════════════════════════════════════════════════

// Dashboard live (temps réel)
router.get("/:groupId/dashboard/live", canView, async (req, res, next) => {
  try {
    const data = await getLiveDashboard(req.params.groupId);
    res.json(data);
  } catch (err) { next(err); }
});

// Générer un rapport consolidé
router.post("/:groupId/reports/generate",
  canAdmin,
  body("periodStart").isISO8601(),
  body("periodEnd").isISO8601(),
  body("type").optional().isIn(["DAILY","WEEKLY","MONTHLY","ANNUAL","CUSTOM"]),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Dates invalides", 400);

      const report = await generateConsolidatedReport(
        req.params.groupId,
        new Date(req.body.periodStart),
        new Date(req.body.periodEnd),
        req.body.type || "CUSTOM"
      );
      res.status(201).json(report);
    } catch (err) { next(err); }
});

// Lister les rapports
router.get("/:groupId/reports", canView, async (req, res, next) => {
  try {
    const reports = await prisma.consolidatedReport.findMany({
      where:   { groupId: req.params.groupId },
      orderBy: { generatedAt: "desc" },
      take:    50,
      select:  { id: true, type: true, periodStart: true, periodEnd: true, totalTtc: true, ticketCount: true, generatedAt: true },
    });
    res.json(reports);
  } catch (err) { next(err); }
});

// Rapport détaillé
router.get("/:groupId/reports/:reportId", canView, async (req, res, next) => {
  try {
    const report = await prisma.consolidatedReport.findFirst({
      where: { id: req.params.reportId, groupId: req.params.groupId },
    });
    if (!report) throw new AppError("Rapport introuvable", 404);
    res.json(report);
  } catch (err) { next(err); }
});

// Live Dashboard / Monitoring
router.get("/:groupId/live", canView, async (req, res, next) => {
  try {
    const dashboard = await getLiveDashboard(req.params.groupId);
    res.json(dashboard);
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// BROADCAST
// ════════════════════════════════════════════════════════════════

router.post("/:groupId/broadcast",
  canAdmin,
  body("title").notEmpty(),
  body("body").notEmpty(),
  async (req, res, next) => {
    try {
      const msg = await sendBroadcast(req.params.groupId, req.user.id, req.body);
      // Émettre via Socket.IO
      req.io?.to(`group:${req.params.groupId}`).emit("broadcast:new", msg);
      res.status(201).json(msg);
    } catch (err) { next(err); }
});

router.get("/:groupId/broadcast", canView, async (req, res, next) => {
  try {
    const msgs = await prisma.broadcastMessage.findMany({
      where:   { groupId: req.params.groupId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { sentAt: "desc" },
      take:    20,
    });
    res.json(msgs);
  } catch (err) { next(err); }
});

export default router;
