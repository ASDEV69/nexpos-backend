// src/services/campaignService.js
// ─────────────────────────────────────────────────────────────────
// Service de campagnes marketing NEXPOS
// SMS · Email · Segmentation · RGPD
// ─────────────────────────────────────────────────────────────────
import { prisma }       from "../utils/prisma.js";
import { logger }       from "../utils/logger.js";
import { getSegment }   from "./loyaltyService.js";

// Providers d'envoi (injecter en prod)
// SMS : Twilio, OVH SMS, Vonage
// Email : SendGrid, Brevo (ex-Sendinblue), Mailjet

const SMS_TEMPLATES = {
  BIRTHDAY:     "🎂 Joyeux anniversaire {firstName} ! {points} pts vous attendent. Valable 7j.",
  LEVEL_UP:     "🎉 Félicitations {firstName} ! Nouveau niveau {level}. Profitez de vos avantages.",
  INACTIVE:     "Bonjour {firstName}, vous nous manquez ! -10% sur votre prochain repas. Code: {code}",
  PROMO:        "{body}",
  WIN_BACK:     "On ne vous a pas vu depuis {days} jours ! Revenez avec {points} pts bonus.",
};

/**
 * Estime la portée d'une campagne avant envoi.
 */
export async function estimateCampaignReach(establishmentId, segment, type) {
  const customers = await getSegment(establishmentId, segment);
  const withEmail = customers.filter(c => c.email).length;
  const withPhone = customers.filter(c => c.phone).length;

  return {
    total:     customers.length,
    withEmail,
    withPhone,
    reachable: type === "EMAIL" ? withEmail : type === "SMS" ? withPhone : customers.length,
  };
}

/**
 * Lance l'envoi d'une campagne.
 * En mode asynchrone via queue (pas d'envoi synchrone de masse).
 */
export async function sendCampaign(campaignId) {
  const campaign = await prisma.campaign.findUnique({
    where:   { id: campaignId },
    include: { establishment: true },
  });

  if (!campaign) throw new Error("Campagne introuvable");
  if (campaign.status !== "SCHEDULED" && campaign.status !== "DRAFT") {
    throw new Error(`Campagne en statut ${campaign.status} — impossible d'envoyer`);
  }

  // Passer en mode SENDING
  await prisma.campaign.update({
    where: { id: campaignId },
    data:  { status: "SENDING" },
  });

  logger.info(`[Campaign] Démarrage envoi: "${campaign.name}" (${campaign.type})`);

  try {
    const customers = await getSegment(campaign.establishmentId, campaign.targetSegment);

    let sentCount = 0;
    const batchSize = 50;

    for (let i = 0; i < customers.length; i += batchSize) {
      const batch = customers.slice(i, i + batchSize);

      await Promise.allSettled(batch.map(async customer => {
        try {
          const personalized = personalizeMessage(campaign.bodyText, customer);

          if (campaign.type === "SMS" && customer.phone) {
            await sendSms(customer.phone, personalized, campaign.establishmentId);
          } else if (campaign.type === "EMAIL" && customer.email) {
            await sendEmail(customer.email, campaign.subject || campaign.name, personalized, campaign.bodyHtml);
          }

          await prisma.campaignLog.create({
            data: { campaignId, customerId: customer.id, status: "sent" },
          });
          sentCount++;
        } catch (err) {
          await prisma.campaignLog.create({
            data: { campaignId, customerId: customer.id, status: "failed", errorMsg: err.message },
          });
        }
      }));

      // Pause entre les batches pour respecter les rate limits
      if (i + batchSize < customers.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    await prisma.campaign.update({
      where: { id: campaignId },
      data:  { status: "SENT", sentAt: new Date(), sentCount },
    });

    logger.info(`[Campaign] "${campaign.name}" envoyée — ${sentCount}/${customers.length} destinataires`);
    return { success: true, sentCount, totalTargets: customers.length };

  } catch (err) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data:  { status: "PAUSED" },
    });
    logger.error(`[Campaign] Erreur envoi "${campaign.name}":`, err);
    throw err;
  }
}

function personalizeMessage(template, customer) {
  return template
    .replace(/{firstName}/g,    customer.firstName || "")
    .replace(/{lastName}/g,     customer.lastName  || "")
    .replace(/{points}/g,       String(customer.loyaltyPoints || 0))
    .replace(/{level}/g,        customer.loyaltyLevel || "")
    .replace(/{totalSpent}/g,   parseFloat(customer.totalSpent || 0).toFixed(0))
    .replace(/{visitCount}/g,   String(customer.visitCount || 0));
}

async function sendSms(phone, message, establishmentId) {
  // En production : appel API Twilio / OVH SMS
  logger.info(`[SMS] → ${phone}: ${message.slice(0, 50)}...`);
}

async function sendEmail(to, subject, text, html) {
  // En production : appel API Brevo / SendGrid
  logger.info(`[Email] → ${to}: ${subject}`);
}
