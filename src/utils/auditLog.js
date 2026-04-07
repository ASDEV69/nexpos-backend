// src/utils/auditLog.js — Journal d'audit immuable (NF525)
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

export async function auditLog({ establishmentId, userId, action, entity, entityId, before, after, ip, userAgent }) {
  try {
    await prisma.auditLog.create({
      data: {
        establishmentId,
        userId: userId || null,
        action,
        entity,
        entityId: entityId || null,
        before: before || null,
        after: after || null,
        ip: ip || null,
        userAgent: userAgent || null,
      },
    });
  } catch (err) {
    logger.error("Erreur auditLog:", err);
  }
}
