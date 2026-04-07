// src/routes/stocks.js — API REST Gestion des Stocks
import { Router } from "express";
import { authenticate, requireManager, requireCashier } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";
import { body, validationResult } from "express-validator";
import { prisma } from "../utils/prisma.js";
import { 
  createStockMovement, 
  processInventory, 
  getStockAlerts, 
  getStockValuation, 
  generatePurchaseOrder 
} from "../services/stockService.js";

export const stockRouter = Router();
stockRouter.use(authenticate);

// Mouvements
stockRouter.get("/movements", requireCashier, async (req, res, next) => {
  try {
    const { productId, type, startDate, endDate, page = 1, limit = 100 } = req.query;
    const where = { establishmentId: req.establishmentId };
    if (productId) where.productId = productId;
    if (type)      where.type      = type;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate)   where.createdAt.lte = new Date(endDate);
    }

    const [moves, total] = await prisma.$transaction([
      prisma.stockMovement.findMany({
        where,
        include: { product: { select: { name: true, emoji: true, stockQty: true } } },
        orderBy: { createdAt: "desc" },
        skip:  (parseInt(page) - 1) * parseInt(limit),
        take:  parseInt(limit),
      }),
      prisma.stockMovement.count({ where }),
    ]);

    res.json({ movements: moves, total });
  } catch (err) { next(err); }
});

// Ajustement manuel
stockRouter.post("/adjust",
  requireManager,
  body("productId").isUUID(),
  body("qty").isFloat(),
  body("type").isIn(["PURCHASE", "ADJUSTMENT", "WASTE"]),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);
      const move = await createStockMovement({ ...req.body, establishmentId: req.establishmentId, userId: req.user.id });
      res.status(201).json(move);
    } catch (err) { next(err); }
});

// Inventaire
stockRouter.post("/inventory",
  requireManager,
  body("counts").isArray({ min: 1 }),
  async (req, res, next) => {
    try {
      const results = await processInventory(req.establishmentId, req.user.id, req.body.counts);
      res.json({ results, summary: {
        total:  results.length,
        ok:     results.filter(r => r.status === "ok").length,
        gains:  results.filter(r => r.status === "gain").length,
        losses: results.filter(r => r.status === "loss").length,
      }});
    } catch (err) { next(err); }
});

// Alertes
stockRouter.get("/alerts", requireCashier, async (req, res, next) => {
  try {
    const alerts = await getStockAlerts(req.establishmentId);
    res.json(alerts);
  } catch (err) { next(err); }
});

// Valorisation
stockRouter.get("/valuation", requireManager, async (req, res, next) => {
  try {
    const val = await getStockValuation(req.establishmentId);
    res.json(val);
  } catch (err) { next(err); }
});

// Bon de commande automatique
stockRouter.post("/purchase-order",
  requireManager,
  body("productIds").isArray({ min: 1 }),
  async (req, res, next) => {
    try {
      const order = await generatePurchaseOrder(
        req.establishmentId,
        req.body.productIds,
        req.body.supplierId
      );
      res.json(order);
    } catch (err) { next(err); }
});

export default stockRouter;
