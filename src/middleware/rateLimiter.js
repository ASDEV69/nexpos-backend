// src/middleware/rateLimiter.js — Rate limiting global + par endpoint
import rateLimit from "express-rate-limit";

// Limite globale : 500 requêtes / 15 min
export const rateLimiter = rateLimit({
  windowMs:        15 * 60 * 1000, // 15 minutes
  max:             500,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "Trop de requêtes — réessayez dans 15 minutes" },
  skip: (req) => process.env.NODE_ENV === "development",
});

// Limite stricte pour l'auth (anti brute-force PIN) : 20 tentatives / 15 min
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  message:  { error: "Trop de tentatives de connexion" },
});

// Limite pour les paiements : 60 / 15 min
export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      60,
  message:  { error: "Trop de tentatives de paiement — réessayez plus tard" },
});
