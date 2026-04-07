// src/routes/auth.js — Authentification par PIN + JWT
import { Router } from "express";
import { body, validationResult } from "express-validator";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../utils/prisma.js";
import { authenticate } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";
import { auditLog } from "../utils/auditLog.js";

const router = Router();

// ─── LOGIN (PIN 4 chiffres) ───────────────────────────────────────
router.post("/login",
  body("establishmentId").isUUID(),
  body("pin").isLength({ min: 4, max: 4 }).isNumeric(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);

      const { establishmentId, pin } = req.body;

      // Trouver l'utilisateur par établissement (on identifie par PIN unique dans l'établissement)
      // En production, on peut aussi ajouter le champ userId
      const users = await prisma.user.findMany({
        where: { establishmentId, active: true },
        include: { establishment: true },
      });

      let foundUser = null;
      for (const user of users) {
        if (await bcrypt.compare(pin, user.pin)) {
          foundUser = user;
          break;
        }
      }

      if (!foundUser) {
        await new Promise(r => setTimeout(r, 500)); // Anti brute-force
        throw new AppError("PIN incorrect", 401);
      }

      // Créer les tokens JWT
      const accessToken  = generateAccessToken(foundUser);
      const refreshToken = generateRefreshToken(foundUser);

      // Sauvegarder la session en base
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8h
      await prisma.session.create({
        data: {
          id: uuidv4(),
          userId: foundUser.id,
          token: accessToken,
          expiresAt,
        },
      });

      // Mettre à jour lastLoginAt
      await prisma.user.update({
        where: { id: foundUser.id },
        data: { lastLoginAt: new Date() },
      });

      await auditLog({
        establishmentId,
        userId: foundUser.id,
        action: "LOGIN",
        entity: "user",
        entityId: foundUser.id,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });

      res.json({
        user: {
          id:      foundUser.id,
          name:    foundUser.name,
          initial: foundUser.initial,
          role:    foundUser.role,
        },
        establishment: {
          id:         foundUser.establishment.id,
          name:       foundUser.establishment.name,
          address:    foundUser.establishment.address,
          zipCode:    foundUser.establishment.zipCode,
          city:       foundUser.establishment.city,
          phone:      foundUser.establishment.phone,
          email:      foundUser.establishment.email,
          siret:      foundUser.establishment.siret,
          vatNumber:  foundUser.establishment.vatNumber,
          logo:       foundUser.establishment.logo,
          currency:   foundUser.establishment.currency,
          groupId:    foundUser.establishment.groupId ?? null,
        },
        accessToken,
        refreshToken,
        expiresAt,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── REFRESH TOKEN ────────────────────────────────────────────────
router.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new AppError("Refresh token manquant", 400);

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_SECRET + "_refresh");
    } catch {
      throw new AppError("Refresh token invalide ou expiré", 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      include: { establishment: true },
    });

    if (!user?.active) throw new AppError("Compte désactivé", 401);

    const newAccessToken = generateAccessToken(user);
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

    await prisma.session.create({
      data: { id: uuidv4(), userId: user.id, token: newAccessToken, expiresAt },
    });

    res.json({ accessToken: newAccessToken, expiresAt });
  } catch (err) {
    next(err);
  }
});

// ─── LOGOUT ───────────────────────────────────────────────────────
router.post("/logout", authenticate, async (req, res, next) => {
  try {
    const token = req.headers.authorization?.slice(7);
    if (token) {
      await prisma.session.updateMany({
        where: { token },
        data: { revokedAt: new Date() },
      });
    }

    await auditLog({
      establishmentId: req.establishmentId,
      userId: req.user.id,
      action: "LOGOUT",
      entity: "user",
      entityId: req.user.id,
    });

    res.json({ message: "Déconnexion réussie" });
  } catch (err) {
    next(err);
  }
});

// ─── PROFIL UTILISATEUR CONNECTÉ ──────────────────────────────────
router.get("/me", authenticate, (req, res) => {
  res.json({
    user: {
      id:      req.user.id,
      name:    req.user.name,
      initial: req.user.initial,
      role:    req.user.role,
      email:   req.user.email,
    },
    establishment: {
      id:      req.establishment.id,
      name:    req.establishment.name,
      siret:   req.establishment.siret,
      licenseExpiresAt: req.establishment.licenseExpiresAt,
    },
  });
});

// ─── HELPERS JWT ─────────────────────────────────────────────────
function generateAccessToken(user) {
  return jwt.sign(
    {
      sub:            user.id,
      role:           user.role,
      establishmentId:user.establishmentId,
      type:           "access",
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
  );
}

function generateRefreshToken(user) {
  return jwt.sign(
    { sub: user.id, type: "refresh" },
    process.env.JWT_SECRET + "_refresh",
    { expiresIn: "30d" }
  );
}

export default router;
