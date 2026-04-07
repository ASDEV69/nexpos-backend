// src/routes/health.js — Health check endpoint
import { Router } from "express";
import { prisma } from "../utils/prisma.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status:  "ok",
      service: "NEXPOS Backend",
      version: process.env.SOFTWARE_VERSION || "2.0.0",
      nf525:   true,
      db:      "connected",
      uptime:  Math.floor(process.uptime()),
      ts:      new Date(),
    });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

export default router;
