// src/utils/logger.js — Winston logger avec rotation
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, stack }) =>
  `${timestamp} [${level.toUpperCase()}] ${stack || message}`
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), errors({ stack: true }), logFormat),
  transports: [
    // Console en développement
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: "HH:mm:ss" }), logFormat),
      silent: process.env.NODE_ENV === "test",
    }),
    // Rotation fichiers (6 ans de conservation — obligatoire NF525)
    new DailyRotateFile({
      filename:    path.join(process.env.LOG_DIR || "./logs", "nexpos-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles:    "2190d", // 6 ans
      maxSize:     "50m",
      zippedArchive: true,
    }),
    // Fichier erreurs séparé
    new DailyRotateFile({
      level:       "error",
      filename:    path.join(process.env.LOG_DIR || "./logs", "errors-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles:    "2190d",
    }),
  ],
});
