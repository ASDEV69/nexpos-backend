// src/middleware/errorHandler.js — Gestion centralisée des erreurs
import { logger } from "../utils/logger.js";

export class AppError extends Error {
  constructor(message, statusCode = 500, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

export function notFound(req, res) {
  res.status(404).json({ error: `Route ${req.method} ${req.path} introuvable` });
}

export function errorHandler(err, req, res, _next) {
  if (err.isOperational) {
    logger.warn(`[${err.statusCode}] ${err.message} — ${req.method} ${req.path}`);
    return res.status(err.statusCode).json({
      error: err.message,
      code:  err.code || null,
    });
  }

  // Erreurs Prisma
  if (err.code === "P2002") {
    return res.status(409).json({ error: "Doublon — cet enregistrement existe déjà" });
  }
  if (err.code === "P2025") {
    return res.status(404).json({ error: "Enregistrement introuvable" });
  }

  logger.error("Erreur interne:", err);
  res.status(500).json({ error: "Erreur interne du serveur" });
}
