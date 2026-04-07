// src/utils/seed.js — Données initiales pour le développement
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding NEXPOS...");

  // ── Établissement ─────────────────────────────────────────────
  const estab = await prisma.establishment.upsert({
    where: { siret: "12345678901234" },
    update: {},
    create: {
      id:       uuid(),
      name:     "Le Bistrot de Paris",
      siret:    "12345678901234",
      address:  "12 rue de la Paix",
      zipCode:  "75001",
      city:     "Paris",
      vatNumber:"FR12345678901",
      phone:    "01 23 45 67 89",
      email:    "contact@bistrot-paris.fr",
    },
  });
  console.log(`✅ Établissement: ${estab.name} (${estab.id})`);

  // ── Taux de TVA ────────────────────────────────────────────────
  const tva55 = await prisma.tvaRate.upsert({
    where: { establishmentId_rate: { establishmentId: estab.id, rate: 5.5 } },
    update: {}, create: { id: uuid(), establishmentId: estab.id, rate: 5.5, label: "TVA 5,5% — Produits alimentaires" },
  });
  const tva10 = await prisma.tvaRate.upsert({
    where: { establishmentId_rate: { establishmentId: estab.id, rate: 10 } },
    update: {}, create: { id: uuid(), establishmentId: estab.id, rate: 10, label: "TVA 10% — Restauration" },
  });
  const tva20 = await prisma.tvaRate.upsert({
    where: { establishmentId_rate: { establishmentId: estab.id, rate: 20 } },
    update: {}, create: { id: uuid(), establishmentId: estab.id, rate: 20, label: "TVA 20% — Boissons alcoolisées" },
  });
  console.log("✅ Taux TVA: 5.5%, 10%, 20%");

  // ── Catégories ─────────────────────────────────────────────────
  const catData = [
    { label: "Menus",    icon: "🍱", color: "#f472b6", sortOrder: 0 },
    { label: "Entrées",  icon: "🥗", color: "#22d07a", sortOrder: 1 },
    { label: "Plats",    icon: "🍽️",color: "#4f7bff", sortOrder: 2 },
    { label: "Desserts", icon: "🍮", color: "#ffb84d", sortOrder: 3 },
    { label: "Boissons", icon: "🥤", color: "#38d9f5", sortOrder: 4 },
    { label: "Snacks",   icon: "🥪", color: "#9b6dff", sortOrder: 5 },
  ];

  const cats = {};
  for (const c of catData) {
    const cat = await prisma.category.upsert({
      where: { id: `cat_${estab.id}_${c.label}` },
      update: c,
      create: { id: `cat_${estab.id}_${c.label}`, establishmentId: estab.id, ...c },
    });
    cats[c.label] = cat;
  }
  console.log("✅ Catégories créées");

  // ── Utilisateurs ───────────────────────────────────────────────
  const usersData = [
    { name: "Jean Dupont",  role: "ADMIN",   pin: "1234", initial: "JD" },
    { name: "Marie Curie",  role: "CASHIER", pin: "5678", initial: "MC" },
    { name: "Alex Martin",  role: "WAITER",  pin: "9012", initial: "AM" },
  ];
  for (const u of usersData) {
    const pinHash = await bcrypt.hash(u.pin, 12);
    await prisma.user.upsert({
      where: { id: `user_${estab.id}_${u.initial}` },
      update: {},
      create: { id: `user_${estab.id}_${u.initial}`, establishmentId: estab.id, name: u.name, role: u.role, initial: u.initial, pin: pinHash },
    });
  }
  console.log("✅ Utilisateurs: Jean (1234), Marie (5678), Alex (9012)");

  // ── Moyens de paiement ─────────────────────────────────────────
  const payData = [
    { label: "Carte Bancaire",    icon: "💳", trAllowed: false, sortOrder: 0 },
    { label: "Espèces",           icon: "💶", trAllowed: false, sortOrder: 1 },
    { label: "Chèque",            icon: "📄", trAllowed: false, sortOrder: 2 },
    { label: "Ticket Restaurant", icon: "🎫", trAllowed: true,  sortOrder: 3 },
  ];
  for (const p of payData) {
    await prisma.paymentMode.upsert({
      where: { id: `pay_${estab.id}_${p.label}` },
      update: {},
      create: { id: `pay_${estab.id}_${p.label}`, establishmentId: estab.id, ...p },
    });
  }
  console.log("✅ Modes de paiement créés");

  // ── Tables ─────────────────────────────────────────────────────
  for (let i = 1; i <= 10; i++) {
    await prisma.table.upsert({
      where: { id: `table_${estab.id}_${i}` },
      update: {},
      create: { id: `table_${estab.id}_${i}`, establishmentId: estab.id, label: `T${i}`, section: "Salle principale", posX: (i-1) % 5 * 120, posY: Math.floor((i-1) / 5) * 120 },
    });
  }
  await prisma.table.upsert({ where: { id: `table_${estab.id}_emporter` }, update: {}, create: { id: `table_${estab.id}_emporter`, establishmentId: estab.id, label: "Emporter", section: "Caisse" } });
  console.log("✅ Tables T1–T10 + Emporter");

  // ── Produits ───────────────────────────────────────────────────
  const productsData = [
    { name: "Salade César",       price: 8.50,  cat: "Entrées",  tva: tva10, emoji: "🥗", color: "#22d07a", trEligible: true  },
    { name: "Soupe du Jour",      price: 6.00,  cat: "Entrées",  tva: tva10, emoji: "🍲", color: "#22d07a", trEligible: true  },
    { name: "Steak Frites",       price: 19.50, cat: "Plats",    tva: tva10, emoji: "🥩", color: "#4f7bff", trEligible: true  },
    { name: "Burger Classic",     price: 14.50, cat: "Plats",    tva: tva10, emoji: "🍔", color: "#4f7bff", trEligible: true  },
    { name: "Burger Double",      price: 16.50, cat: "Plats",    tva: tva10, emoji: "🍔", color: "#4f7bff", trEligible: true  },
    { name: "Poulet Rôti",        price: 16.00, cat: "Plats",    tva: tva10, emoji: "🍗", color: "#4f7bff", trEligible: true  },
    { name: "Pasta Carbonara",    price: 13.00, cat: "Plats",    tva: tva10, emoji: "🍝", color: "#4f7bff", trEligible: true  },
    { name: "Tarte Tatin",        price: 7.00,  cat: "Desserts", tva: tva10, emoji: "🥧", color: "#ffb84d", trEligible: false },
    { name: "Crème Brûlée",       price: 6.50,  cat: "Desserts", tva: tva10, emoji: "🍮", color: "#ffb84d", trEligible: false },
    { name: "Moelleux Chocolat",  price: 7.50,  cat: "Desserts", tva: tva10, emoji: "🍫", color: "#ffb84d", trEligible: false },
    { name: "Coca-Cola 33cl",     price: 3.50,  cat: "Boissons", tva: tva20, emoji: "🥤", color: "#38d9f5", trEligible: false },
    { name: "Eau Minérale 50cl",  price: 2.50,  cat: "Boissons", tva: tva20, emoji: "💧", color: "#38d9f5", trEligible: false },
    { name: "Café Expresso",      price: 2.00,  cat: "Boissons", tva: tva20, emoji: "☕", color: "#38d9f5", trEligible: false },
    { name: "Frites Maison",      price: 4.00,  cat: "Snacks",   tva: tva10, emoji: "🍟", color: "#9b6dff", trEligible: true  },
    { name: "Croissant",          price: 1.80,  cat: "Snacks",   tva: tva55, emoji: "🥐", color: "#9b6dff", trEligible: true  },
  ];

  const prods = {};
  for (const p of productsData) {
    const prod = await prisma.product.upsert({
      where: { id: `prod_${estab.id}_${p.name}` },
      update: {},
      create: { id: `prod_${estab.id}_${p.name}`, establishmentId: estab.id, categoryId: cats[p.cat].id, tvaRateId: p.tva.id, name: p.name, price: p.price, emoji: p.emoji, color: p.color, trEligible: p.trEligible },
    });
    prods[p.name] = prod;
  }
  console.log("✅ Produits créés");

  console.log("\n🎉 Seed terminé !");
  console.log(`\n📋 Résumé:`);
  console.log(`   Établissement ID : ${estab.id}`);
  console.log(`   Admin PIN        : 1234 (Jean Dupont)`);
  console.log(`   Caissier PIN     : 5678 (Marie Curie)`);
  console.log(`   Serveur PIN      : 9012 (Alex Martin)`);
  console.log(`\n🚀 Démarrez avec: npm run dev`);
  console.log(`📡 API: http://localhost:3001/api/v1`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
