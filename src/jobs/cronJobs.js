// src/jobs/cronJobs.js — Tâches planifiées
import cron from "node-cron";
import { logger } from "../utils/logger.js";
import { prisma } from "../utils/prisma.js";
import { startCrmJobs } from "./crmJobs.js";

export function startCronJobs() {
  // Clôture automatique à 23h55 (optionnel — désactivé par défaut)
  // cron.schedule("55 23 * * *", async () => { ... });

  // Nettoyage sessions expirées — tous les jours à 3h
  cron.schedule("0 3 * * *", async () => {
    try {
      const deleted = await prisma.session.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      logger.info(`Cron: ${deleted.count} sessions expirées supprimées`);
    } catch (err) {
      logger.error("Cron sessions:", err);
    }
  });

  // Alerte stocks bas — tous les jours à 8h
  cron.schedule("0 8 * * *", async () => {
    try {
      const lowStocks = await prisma.product.findMany({
        where: {
          stockEnabled: true,
          stockAlert:   { not: null },
        },
        select: { name: true, stockQty: true, stockAlert: true, establishment: { select: { name: true } } },
      });
      const alerts = lowStocks.filter(p => parseFloat(p.stockQty) <= parseFloat(p.stockAlert));
      if (alerts.length > 0) {
        logger.warn(`Stocks bas: ${alerts.map(p => p.name).join(", ")}`);
      }
    } catch (err) {
      logger.error("Cron stocks:", err);
    }
  });

  startCrmJobs();

  logger.info("Tâches cron démarrées");
}
