// src/middleware/auth.js — Authentification JWT + RBAC
import jwt from "jsonwebtoken";
import { prisma } from "../utils/prisma.js";
import { AppError } from "./errorHandler.js";

const ROLE_HIERARCHY = { ADMIN: 5, MANAGER: 4, SUPERVISOR: 3, CASHIER: 2, WAITER: 1, KITCHEN: 1 };

// ─── VÉRIFICATION TOKEN JWT ───────────────────────────────────────
export async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new AppError("Token d'authentification manquant", 401);
    }

    const token = header.slice(7);
    let decoded;

    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === "TokenExpiredError") throw new AppError("Session expirée — reconnectez-vous", 401);
      throw new AppError("Token invalide", 401);
    }

    // Vérifier que la session est toujours active en base
    const session = await prisma.session.findUnique({
      where: { token },
      include: { user: { include: { establishment: true } } },
    });

    if (!session || session.revokedAt) throw new AppError("Session révoquée", 401);
    if (session.expiresAt < new Date()) throw new AppError("Session expirée", 401);
    if (!session.user.active) throw new AppError("Compte désactivé", 401);

    req.user            = session.user;
    req.establishmentId = session.user.establishmentId;

    // ─── GESTION MULTI-SITE (CONTEXT SWITCHING) ────────────────────
    const targetEstabId = req.headers["x-establishment-id"];
    if (targetEstabId && targetEstabId !== req.establishmentId) {
      // Vérifier si l'utilisateur a accès au groupe de cet établissement
      const targetEstab = await prisma.establishment.findUnique({
        where: { id: targetEstabId },
        select: { id: true, name: true, groupId: true },
      });

      if (targetEstab?.groupId) {
        const membership = await prisma.groupUser.findUnique({
          where: { groupId_userId: { groupId: targetEstab.groupId, userId: req.user.id } },
        });

        if (membership) {
          req.establishmentId = targetEstab.id;
          req.isContextSwitch = true;
          req.groupRole        = membership.role;
        }
      }
    }

    // Charger l'établissement final (original ou swithé)
    req.establishment = await prisma.establishment.findUnique({
      where: { id: req.establishmentId },
    });

    next();
  } catch (err) {
    next(err);
  }
}

// ─── CONTRÔLE DE RÔLE ────────────────────────────────────────────
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new AppError("Non authentifié", 401));

    const userLevel = ROLE_HIERARCHY[req.user.role] ?? 0;
    const minLevel  = Math.min(...roles.map(r => ROLE_HIERARCHY[r] ?? 99));

    if (userLevel < minLevel) {
      return next(new AppError(
        `Accès refusé — rôle ${roles.join(" ou ")} requis`,
        403
      ));
    }
    next();
  };
}

// Raccourcis
export const requireAdmin   = requireRole("ADMIN");
export const requireManager = requireRole("ADMIN", "MANAGER");
export const requireCashier = requireRole("ADMIN", "MANAGER", "CASHIER");

// ─── CONTRÔLE DE RÔLE GROUPE (FRANCHISE) ───────────────────────
/**
 * Vérifie que l'utilisateur appartient au groupe et possède un rôle suffisant.
 * @param {...string} roles ['OWNER', 'ADMIN', 'ANALYST', 'VIEWER']
 */
export function requireGroupRole(...roles) {
  return async (req, res, next) => {
    const groupId = req.params.groupId || req.body.groupId || req.query.groupId;
    
    if (!groupId) return next(new AppError("ID de groupe manquant dans la requête", 400));
    if (!req.user) return next(new AppError("Utilisateur non authentifié", 401));

    const membership = await prisma.groupUser.findUnique({
      where: { groupId_userId: { groupId, userId: req.user.id } },
    });

    if (!membership) {
      return next(new AppError("Accès refusé — vous n'appartenez pas à ce groupe", 403));
    }

    if (!roles.includes(membership.role)) {
      return next(new AppError(
        `Accès refusé — rôle groupe ${roles.join(" ou ")} requis (votre rôle : ${membership.role})`,
        403
      ));
    }

    // Injecter les infos du groupe pour la suite du traitement
    req.group      = await prisma.group.findUnique({ where: { id: groupId } });
    req.groupRole  = membership.role;
    
    next();
  };
}

export const requireGroupAdmin = requireGroupRole("OWNER", "ADMIN");
