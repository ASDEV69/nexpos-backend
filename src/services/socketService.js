// src/services/socketService.js — WebSocket handlers (KDS, kiosk, livraison)
import { logger } from "../utils/logger.js";

export function setupSocketHandlers(io) {
  io.on("connection", (socket) => {
    const { establishmentId, groupId, role } = socket.handshake.auth;

    if (!establishmentId) { socket.disconnect(); return; }

    // Rejoindre la room de l'établissement
    socket.join(establishmentId);
    
    // Rejoindre la room du groupe (broadcasts franchise)
    if (groupId) {
      socket.join(`group:${groupId}`);
      logger.info(`WS Connected: ${socket.id} — Établissement ${establishmentId} (Groupe ${groupId})`);
    } else {
      logger.info(`WS Connected: ${socket.id} — Établissement ${establishmentId} (${role || "?"})`);
    }

    // KDS cuisine
    if (role === "KITCHEN") socket.join(`kitchen:${establishmentId}`);
    // Borne kiosk
    if (role === "KIOSK") socket.join(`kiosk:${establishmentId}`);
    // Peripheral Manager
    if (role === "PERIPHERAL_MANAGER") socket.join(`peripherals:${establishmentId}`);

    socket.on("table:update", (data) => {
      io.to(establishmentId).emit("table:updated", data);
    });

    socket.on("kds:ready", (data) => {
      io.to(establishmentId).emit("kds:orderReady", data);
    });

    // Périphériques bridging
    socket.on("peripheral:test", (data) => {
      // Forward test request to the peripheral manager of this establishment
      io.to(`peripherals:${establishmentId}`).emit("peripheral:doTest", data);
    });

    socket.on("peripheral:status", (status) => {
      // Forward status to the dashboard (CRM users)
      io.to(establishmentId).emit("peripheral:statusUpdate", status);
    });

    socket.on("disconnect", () => {
      logger.info(`WS Disconnected: ${socket.id}`);
    });
  });
}
