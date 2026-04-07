// src/routes/users.js — Gestion utilisateurs
import { Router } from "express";
import { body, validationResult } from "express-validator";
import bcrypt from "bcryptjs";
import { prisma } from "../utils/prisma.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { AppError } from "../middleware/errorHandler.js";

const VALID_ROLES = ["ADMIN", "MANAGER", "CASHIER", "WAITER", "KITCHEN", "SUPERVISOR"];

const router = Router();
router.use(authenticate, requireManager);

router.get("/", async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { establishmentId: req.establishmentId },
      select: { id: true, name: true, initial: true, role: true, email: true, active: true, lastLoginAt: true, createdAt: true },
    });
    res.json(users);
  } catch (err) { next(err); }
});

router.get("/roles", async (req, res, next) => {
  try {
    res.json({ roles: VALID_ROLES });
  } catch (err) { next(err); }
});

router.post("/",
  body("name").notEmpty().trim(),
  body("pin").isLength({ min: 4, max: 4 }).isNumeric(),
  body("role").isIn(VALID_ROLES).withMessage(`Role invalide, utiliser: ${VALID_ROLES.join(", ")}`),
  body("email").optional().isEmail().withMessage("Email invalide"),
  body("initial").optional().trim().isLength({ min: 2, max: 2 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) throw new AppError("Données invalides", 400);
      const { name, pin, role, email, initial } = req.body;
      const pinHash = await bcrypt.hash(pin, 12);
      const user = await prisma.user.create({
        data: {
          name, role, email: email || null,
          initial: initial || name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(),
          pin: pinHash,
          establishmentId: req.establishmentId,
        },
        select: { id: true, name: true, initial: true, role: true },
      });
      res.status(201).json(user);
    } catch (err) { next(err); }
});

router.put("/:id", async (req, res, next) => {
  try {
    const exists = await prisma.user.findFirst({ where: { id: req.params.id, establishmentId: req.establishmentId } });
    if (!exists) throw new AppError("Utilisateur introuvable", 404);
    const data = { ...req.body };
    if (data.pin) data.pin = await bcrypt.hash(data.pin, 12);
    const user = await prisma.user.update({ where: { id: req.params.id }, data, select: { id: true, name: true, initial: true, role: true, active: true } });
    res.json(user);
  } catch (err) { next(err); }
});

router.delete("/:id", async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) throw new AppError("Impossible de supprimer votre propre compte", 400);
    await prisma.user.update({ where: { id: req.params.id }, data: { active: false } });
    res.json({ message: "Utilisateur désactivé" });
  } catch (err) { next(err); }
});

export default router;
