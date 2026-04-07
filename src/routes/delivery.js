// src/routes/delivery.js — Intégration plateformes de livraison
import { Router } from "express";
import crypto from "crypto";
import { prisma } from "../utils/prisma.js";
import { logger } from "../utils/logger.js";
import { authenticate, requireManager } from "../middleware/auth.js";

const router = Router();

// Webhook Uber Eats (vérification signature HMAC — pas d'auth JWT)
router.post("/webhook/uber-eats", async (req, res, next) => {
  try {
    const sig     = req.headers["x-uber-signature"];
    const secret  = process.env.UBER_EATS_WEBHOOK_SECRET;
    const payload = JSON.stringify(req.body);
    const expected = crypto.createHmac("sha256", secret || "").update(payload).digest("hex");

    if (secret && sig !== expected) return res.status(401).json({ error: "Signature invalide" });

    const { event_type, order } = req.body;
    logger.info(`[UberEats] Webhook: ${event_type}`);

    if (event_type === "orders.notification") {
      // TODO: mapper les produits Uber Eats vers les produits NEXPOS
      logger.info(`[UberEats] Nouvelle commande: ${order?.id}`);
    }

    res.json({ received: true });
  } catch (err) { next(err); }
});

// Webhook Deliveroo
router.post("/webhook/deliveroo", async (req, res, next) => {
  try {
    logger.info(`[Deliveroo] Webhook: ${req.body.event}`);
    res.json({ received: true });
  } catch (err) { next(err); }
});

// Routes protégées pour la config
router.use(authenticate, requireManager);

router.get("/config", async (req, res, next) => {
  try {
    const integrations = await prisma.deliveryIntegration.findMany({
      where: { establishmentId: req.establishmentId },
      select: { id: true, platform: true, restaurantId: true, active: true, lastSyncAt: true },
    });
    res.json(integrations);
  } catch (err) { next(err); }
});

router.put("/config/:platform", async (req, res, next) => {
  try {
    const { platform } = req.params;
    const { restaurantId, active } = req.body;
    const integration = await prisma.deliveryIntegration.upsert({
      where: { establishmentId_platform: { establishmentId: req.establishmentId, platform: platform.toUpperCase() } },
      update: { restaurantId, active },
      create: { establishmentId: req.establishmentId, platform: platform.toUpperCase(), restaurantId, active: active ?? false },
    });
    res.json(integration);
  } catch (err) { next(err); }
});

export default router;
