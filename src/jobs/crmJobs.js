// src/jobs/crmJobs.js
// ─────────────────────────────────────────────────────────────────
// Jobs planifiés CRM — anniversaires, expiration points, relances
// ─────────────────────────────────────────────────────────────────
import cron from "node-cron";
import { prisma }                 from "../utils/prisma.js";
import { logger }                 from "../utils/logger.js";
import { processBirthdayBonuses, expireOldPoints } from "../services/loyaltyService.js";
import { sendCampaign }           from "../services/campaignService.js";

export function startCrmJobs() {

  // ── Bonus anniversaires — tous les jours à 9h ─────────────────
  cron.schedule("0 9 * * *", async () => {
    logger.info("[CRM] Traitement des anniversaires...");
    try {
      const establishments = await prisma.establishment.findMany({ select: { id: true } });
      let total = 0;
      for (const { id } of establishments) {
        const { count } = await processBirthdayBonuses(id);
        total += count;
      }
      logger.info(`[CRM] ${total} bonus anniversaire attribués`);
    } catch (err) {
      logger.error("[CRM] Erreur anniversaires:", err);
    }
  });

  // ── Expiration des points — tous les lundis à 3h ──────────────
  cron.schedule("0 3 * * 1", async () => {
    logger.info("[CRM] Traitement expiration points...");
    try {
      const establishments = await prisma.establishment.findMany({ select: { id: true } });
      for (const { id } of establishments) {
        await expireOldPoints(id);
      }
    } catch (err) {
      logger.error("[CRM] Erreur expiration points:", err);
    }
  });

  // ── Campagnes planifiées — toutes les 15 minutes ──────────────
  cron.schedule("*/15 * * * *", async () => {
    try {
      const due = await prisma.campaign.findMany({
        where: {
          status:      "SCHEDULED",
          scheduledAt: { lte: new Date() },
        },
        select: { id: true, name: true },
        take:   5,
      });
      for (const { id, name } of due) {
        logger.info(`[CRM] Lancement campagne planifiée: "${name}"`);
        await sendCampaign(id).catch(err =>
          logger.error(`[CRM] Erreur campagne "${name}":`, err.message)
        );
      }
    } catch (err) {
      logger.error("[CRM] Erreur vérification campagnes:", err);
    }
  });

  // ── Relance clients inactifs — tous les lundis à 10h ──────────
  // Crée automatiquement une campagne pour les clients inactifs 60j+
  cron.schedule("0 10 * * 1", async () => {
    logger.info("[CRM] Vérification clients inactifs...");
    try {
      const establishments = await prisma.establishment.findMany({ select: { id: true } });
      const cutoff = new Date(Date.now() - 60 * 86400000);

      for (const { id } of establishments) {
        const inactiveCount = await prisma.customer.count({
          where: {
            establishmentId:  id,
            consentMarketing: true,
            deletedAt:        null,
            lastVisitAt:      { lt: cutoff },
          },
        });

        if (inactiveCount >= 5) {
          // Vérifier qu'une campagne de relance n'a pas déjà été envoyée ce mois
          const startOfMonth = new Date();
          startOfMonth.setDate(1); startOfMonth.setHours(0,0,0,0);

          const alreadySent = await prisma.campaign.findFirst({
            where: {
              establishmentId: id,
              targetSegment:   "inactive",
              status:          "SENT",
              sentAt:          { gte: startOfMonth },
            },
          });

          if (!alreadySent) {
            const campaign = await prisma.campaign.create({
              data: {
                establishmentId: id,
                name:        `Relance inactifs — ${new Date().toLocaleDateString("fr-FR")}`,
                type:        "SMS",
                bodyText:    "On ne vous a pas vu depuis un moment, {firstName} ! Revenez avec -10% sur votre prochain repas. Code: RETOUR10",
                targetSegment: "inactive",
                status:      "SCHEDULED",
                scheduledAt: new Date(Date.now() + 60000), // Dans 1 minute
              },
            });
            logger.info(`[CRM] Campagne relance créée pour établissement ${id} — ${inactiveCount} clients ciblés`);
          }
        }
      }
    } catch (err) {
      logger.error("[CRM] Erreur relance inactifs:", err);
    }
  });

  // ── Expiration des récompenses non utilisées ──────────────────
  cron.schedule("0 2 * * *", async () => {
    try {
      const expired = await prisma.customerReward.updateMany({
        where:  { status: "PENDING", expiresAt: { lt: new Date() } },
        data:   { status: "EXPIRED" },
      });
      if (expired.count > 0) {
        logger.info(`[CRM] ${expired.count} récompenses expirées`);
      }
    } catch (err) {
      logger.error("[CRM] Erreur expiration récompenses:", err);
    }
  });

  logger.info("[CRM] Jobs planifiés démarrés (anniversaires, expiration, campagnes, relances)");
}


// ─────────────────────────────────────────────────────────────────
// Intégration dans le workflow de paiement (routes/tickets.js)
// ─────────────────────────────────────────────────────────────────
// Ajouter dans POST /tickets/:id/pay, après la validation :
//
// // Attribution automatique des points fidélité
// if (paidTicket.customerId) {
//   const { earnPoints } = await import("../services/loyaltyService.js");
//   const loyalty = await earnPoints(
//     paidTicket.customerId,
//     paidTicket.id,
//     parseFloat(paidTicket.finalAmount),
//     req.establishmentId
//   );
//   if (loyalty) {
//     req.io?.to(req.establishmentId).emit("loyalty:earned", {
//       customerId: paidTicket.customerId,
//       points:     loyalty.points,
//       newBalance: loyalty.newBalance,
//       levelUp:    loyalty.levelUp,
//       newLevel:   loyalty.newLevel,
//     });
//   }
// }
//
// // Vérifier et appliquer un code de récompense si présent
// if (req.body.rewardCode) {
//   const { useRewardCode } = await import("../services/loyaltyService.js");
//   const rewardResult = await useRewardCode(req.body.rewardCode, paidTicket.id);
//   // Le discount a déjà été appliqué avant le paiement
// }
