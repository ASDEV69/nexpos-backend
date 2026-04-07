import { Router } from "express";
import { body, param, query, validationResult } from "express-validator";
import { prisma }       from "../utils/prisma.js";
import { authenticate, requireGroupAdmin, requireGroupRole } from "../middleware/auth.js";
import { AppError }     from "../middleware/errorHandler.js";
import { 
  generateMonthlyRoyalties, 
  createPurchaseOrder, 
  receivePurchaseOrder 
} from "../services/franchiseService.js";
const router = Router();
router.use(authenticate);

// ════════════════════════════════════════════════════════════════
// REDEVANCES (ROYALTIES)
// ════════════════════════════════════════════════════════════════

// 1. Liste des factures de redevances
router.get("/groups/:groupId/royalties", 
  requireGroupAdmin, 
  async (req, res, next) => {
    try {
      const { period, status } = req.query;
      const invoices = await prisma.royaltyInvoice.findMany({
        where: { 
          groupId: req.params.groupId,
          ...(period ? { period } : {}),
          ...(status ? { status } : {})
        },
        include: { establishment: { select: { name: true, city: true } } },
        orderBy: { period: "desc" }
      });
      res.json(invoices);
    } catch (err) { next(err); }
});

// 2. Générer les redevances pour un mois
router.post("/groups/:groupId/royalties/generate",
  requireGroupAdmin,
  body("period").matches(/^\d{4}-\d{2}$/),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Format de période invalide (YYYY-MM)", 400);

      const invoices = await generateMonthlyRoyalties(req.params.groupId, req.body.period);
      res.status(201).json({ message: `${invoices.length} factures générées`, invoices });
    } catch (err) { next(err); }
});

// 3. Configuration des redevances par établissement
router.put("/groups/:groupId/royalties/config/:estabId",
  requireGroupAdmin,
  body("percentage").isFloat({ min: 0, max: 100 }),
  body("fixedMonthly").isFloat({ min: 0 }),
  async (req, res, next) => {
    try {
      const config = await prisma.royaltyConfig.upsert({
        where: { establishmentId: req.params.estabId },
        update: req.body,
        create: { ...req.body, groupId: req.params.groupId, establishmentId: req.params.estabId }
      });
      res.json(config);
    } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// CENTRALE D'ACHAT (PROCUREMENT)
// ════════════════════════════════════════════════════════════════

// 1. Liste des fournisseurs
router.get("/groups/:groupId/suppliers", async (req, res, next) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      where: { groupId: req.params.groupId, active: true },
      include: { products: true }
    });
    res.json(suppliers);
  } catch (err) { next(err); }
});

// 2. Passer une commande (Côté Établissement)
router.post("/purchase-orders",
  body("supplierId").isUUID(),
  body("lines").isArray({ min: 1 }),
  async (req, res, next) => {
    try {
      const { supplierId, lines, note } = req.body;
      const order = await createPurchaseOrder(req.establishmentId, supplierId, lines, note);
      res.status(201).json(order);
    } catch (err) { next(err); }
});

// 3. Historique des commandes de l'établissement
router.get("/purchase-orders", async (req, res, next) => {
  try {
    const orders = await prisma.purchaseOrder.findMany({
      where: { establishmentId: req.establishmentId },
      include: { supplier: { select: { name: true } } },
      orderBy: { createdAt: "desc" }
    });
    res.json(orders);
  } catch (err) { next(err); }
});

// 4. Réceptionner une commande
router.patch("/purchase-orders/:id/receive", async (req, res, next) => {
  try {
    const order = await receivePurchaseOrder(req.params.id);
    res.json(order);
  } catch (err) { next(err); }
});

export default router;
