// src/server.js — Point d'entrée NEXPOS Backend
import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server as SocketIO } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";

import { logger } from "./utils/logger.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { rateLimiter, authLimiter, paymentLimiter } from "./middleware/rateLimiter.js";
import { setupSocketHandlers } from "./services/socketService.js";
import { startCronJobs } from "./jobs/cronJobs.js";

// ─── ROUTES ──────────────────────────────────────────────────────
import authRoutes        from "./routes/auth.js";
import ticketRoutes      from "./routes/tickets.js";
import productRoutes     from "./routes/products.js";
import categoryRoutes    from "./routes/categories.js";
import menuRoutes        from "./routes/menus.js";
import tableRoutes       from "./routes/tables.js";
import closureRoutes     from "./routes/closures.js";
import reportRoutes      from "./routes/reports.js";
import stockRoutes       from "./routes/stocks.js";
import userRoutes        from "./routes/users.js";
import paymentModeRoutes from "./routes/paymentModes.js";
import tvaRoutes         from "./routes/tva.js";
import deliveryRoutes    from "./routes/delivery.js";
import healthRoutes      from "./routes/health.js";
import customerRoutes    from "./routes/customers.js";
import analyticsRoutes   from "./routes/analytics.js";
import reservationRoutes from "./routes/reservations.js";

import groupRoutes       from "./routes/groups.js";
import storefrontRoutes  from "./routes/storefront.js";
import peripheralRoutes  from "./routes/peripherals.js";
import establishmentRoutes from "./routes/establishments.js";
import franchiseRoutes     from "./routes/franchise.js";

const app    = express();
const server = createServer(app);
const io     = new SocketIO(server, {
  cors: {
    origin: process.env.CORS_ORIGINS?.split(",") || "*",
    methods: ["GET", "POST"],
  },
});

const API = process.env.API_PREFIX || "/api/v1";
const PORT = parseInt(process.env.PORT || "3001", 10);
const IS_PROD = process.env.NODE_ENV === "production";

// ─── MIDDLEWARES GLOBAUX ──────────────────────────────────────────
app.use(helmet({
  // CSP activé en production, désactivé en dev pour faciliter le debug
  contentSecurityPolicy: IS_PROD ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:"],
    },
  } : false,
}));
app.use(compression());
app.use(cors({
  origin: function(origin, callback) { 
    // Echo any origin to fix CORS blocks with credentials: true
    callback(null, true); 
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" })); // 10mb pour les images base64
app.use(express.urlencoded({ extended: true }));
app.use(morgan("combined", {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.path === "/health",
}));
app.use(rateLimiter);

// Injecter io dans les requêtes pour les routes qui en ont besoin
app.use((req, _res, next) => { req.io = io; next(); });

// ─── ROUTES ───────────────────────────────────────────────────────
app.use("/health",              healthRoutes);
app.use(`${API}/storefront`,    storefrontRoutes);
app.use(`${API}/auth`,          authLimiter, authRoutes);       // Rate limit strict sur l'auth
app.use(`${API}/tickets`,       ticketRoutes);
app.use(`${API}/products`,      productRoutes);
app.use(`${API}/categories`,    categoryRoutes);
app.use(`${API}/menus`,         menuRoutes);
app.use(`${API}/tables`,        tableRoutes);
app.use(`${API}/closures`,      closureRoutes);
app.use(`${API}/reports`,       reportRoutes);
app.use(`${API}/stocks`,        stockRoutes);
app.use(`${API}/users`,         userRoutes);
app.use(`${API}/payment-modes`, paymentModeRoutes);
app.use(`${API}/tva`,           tvaRoutes);
app.use(`${API}/delivery`,      deliveryRoutes);
app.use(`${API}/customers`,     customerRoutes);
app.use(`${API}/analytics`,     analyticsRoutes);
app.use(`${API}/reservations`,  reservationRoutes);
app.use(`${API}/groups`,        groupRoutes);
app.use(`${API}/peripherals`,   peripheralRoutes);
app.use(`${API}/establishments`, establishmentRoutes);
app.use(`${API}/franchise`,      franchiseRoutes);

// ─── ERREURS ──────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── WEBSOCKET ────────────────────────────────────────────────────
setupSocketHandlers(io);

// ─── DÉMARRAGE ────────────────────────────────────────────────────
server.listen(PORT, () => {
  logger.info(`🚀 NEXPOS Backend démarré sur le port ${PORT}`);
  logger.info(`📡 API disponible sur ${API}`);
  logger.info(`🔒 NF525 — Signature activée`);
  logger.info(`⚡ WebSocket actif (KDS, borne kiosk, livraison)`);
  logger.info(`🛡️  CSP: ${IS_PROD ? "activé" : "désactivé (dev)"}`);

  // Démarrer les tâches planifiées (clôtures automatiques, alertes stocks)
  if (IS_PROD) {
    startCronJobs();
    logger.info("⏰ Tâches planifiées démarrées");
  }
});

// Gestion propre de l'arrêt
const shutdown = (signal) => {
  logger.info(`${signal} reçu — Arrêt propre...`);
  server.close(() => {
    logger.info("Serveur HTTP fermé");
    process.exit(0);
  });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  logger.error("Exception non capturée:", err);
  process.exit(1);
});

export { app, io };
// NFC/NF525 NEXPOS Backend ready
