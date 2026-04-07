// src/utils/prisma.js — Client Prisma singleton
import { PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

const globalForPrisma = global;
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: [
    { emit: "event", level: "query"  },
    { emit: "event", level: "error"  },
    { emit: "event", level: "warn"   },
  ],
});

if (process.env.NODE_ENV === "development") {
  prisma.$on("query", e => logger.debug(`Prisma Query: ${e.query} — ${e.duration}ms`));
}
prisma.$on("error", e => logger.error("Prisma Error:", e));

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
