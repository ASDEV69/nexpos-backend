/**
 * setup-accompagnements.mjs
 * Crée les sauces, suppléments et options de cuisson,
 * puis les lie automatiquement aux produits concernés.
 *
 * Usage : node src/utils/setup-accompagnements.mjs
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

const EST_ID   = 'a7276c31-81c3-4250-9ba4-ebba8b108e7c';
const CAT_ACC  = '58339984-6748-4905-abfd-d59633217ef5'; // categorie "accompagnements"
const TVA_10   = 'fd5d0b04-d5d4-427e-a04c-8a08a9b150ca'; // TVA 10% restauration

// ─── 1. DÉFINITION DES OPTIONS ────────────────────────────────────

const SAUCES = [
  { name: 'Ketchup',       emoji: '🍅', price: 0 },
  { name: 'Mayonnaise',    emoji: '🫙', price: 0 },
  { name: 'Sauce Burger',  emoji: '🫙', price: 0 },
  { name: 'Sauce BBQ',     emoji: '🍯', price: 0 },
  { name: 'Harissa',       emoji: '🌶️', price: 0 },
  { name: 'Moutarde',      emoji: '🌿', price: 0 },
];

const SUPPLEMENTS = [
  { name: 'Fromage',       emoji: '🧀', price: 0.50 },
  { name: 'Bacon',         emoji: '🥓', price: 1.00 },
  { name: 'Oeuf',          emoji: '🍳', price: 0.80 },
  { name: 'Avocat',        emoji: '🥑', price: 1.50 },
];

const CUISSON = [
  { name: 'Saignant',      emoji: '🩸', price: 0 },
  { name: 'À point',       emoji: '🥩', price: 0 },
  { name: 'Bien cuit',     emoji: '🔥', price: 0 },
];

// Mots-clés pour identifier les produits par type
const BURGER_KEYWORDS  = ['burger', 'tex-mex', 'double'];
const VIANDE_KEYWORDS  = ['steak', 'viande', 'entrecote', 'côte', 'magret', 'poulet', 'burger'];
const PLAT_CATEGORIES  = [
  'cat_a7276c31-81c3-4250-9ba4-ebba8b108e7c_Plats',
  '70f5a9d5-3933-4f9c-97e0-5b4855dcc3e4', // VIANDES
];

// ─── 2. HELPERS ───────────────────────────────────────────────────

async function getOrCreateProduct(name, emoji, price) {
  const existing = await prisma.product.findFirst({
    where: { name, establishmentId: EST_ID },
  });
  if (existing) {
    console.log(`  ✓ Existe déjà : ${emoji} ${name}`);
    return existing;
  }
  const product = await prisma.product.create({
    data: {
      id:              randomUUID(),
      establishmentId: EST_ID,
      categoryId:      CAT_ACC,
      tvaRateId:       TVA_10,
      name,
      emoji,
      price,
      active:          true,
      stockEnabled:    false,
    },
  });
  console.log(`  + Créé : ${emoji} ${name} (${price}€)`);
  return product;
}

async function linkIfMissing(productId, accompanimentId, priceExtra, required) {
  const exists = await prisma.productAccompaniment.findFirst({
    where: { productId, accompanimentId },
  });
  if (exists) return;
  await prisma.productAccompaniment.create({
    data: {
      id: randomUUID(),
      productId,
      accompanimentId,
      priceExtra,
      required,
      sortOrder: 0,
      label: null,
    },
  });
}

// ─── 3. SCRIPT PRINCIPAL ─────────────────────────────────────────

console.log('\n══════════════════════════════════════════');
console.log('  NEXPOS — Setup Accompagnements');
console.log('══════════════════════════════════════════\n');

// Étape 1 : Charger les produits EXISTANTS avant toute création
const allProducts = await prisma.product.findMany({
  where: { establishmentId: EST_ID, active: true },
  select: { id: true, name: true, categoryId: true, emoji: true },
});
// Exclure ceux déjà dans la catégorie accompagnements
const mainProducts = allProducts.filter(p => p.categoryId !== CAT_ACC);
console.log(`${mainProducts.length} produits principaux chargés\n`);

// Étape 2 : Créer les produits accompagnements
console.log('── Sauces ───────────────────────────────');
const sauceProducts = [];
for (const s of SAUCES) {
  sauceProducts.push(await getOrCreateProduct(s.name, s.emoji, s.price));
}

console.log('\n── Suppléments ──────────────────────────');
const suppProducts = [];
for (const s of SUPPLEMENTS) {
  suppProducts.push(await getOrCreateProduct(s.name, s.emoji, s.price));
}

console.log('\n── Options de cuisson ───────────────────');
const cuissonProducts = [];
for (const c of CUISSON) {
  cuissonProducts.push(await getOrCreateProduct(c.name, c.emoji, c.price));
}

console.log(`\n── Liaison aux produits (${mainProducts.length} produits) ──`);

let linked = 0;
for (const product of mainProducts) {
  const nameLower = product.name.toLowerCase();
  const isBurger  = BURGER_KEYWORDS.some(k => nameLower.includes(k));
  const isViande  = VIANDE_KEYWORDS.some(k => nameLower.includes(k));
  const isPlat    = PLAT_CATEGORIES.includes(product.categoryId);

  if (!isBurger && !isViande && !isPlat) continue;

  console.log(`\n  ${product.emoji || '🍽️'} ${product.name}`);

  // Sauces → burgers et plats
  if (isBurger || isPlat) {
    for (const s of sauceProducts) {
      await linkIfMissing(product.id, s.id, 0, false);
    }
    console.log(`    → ${sauceProducts.length} sauces liées (optionnelles)`);

    // Suppléments → seulement pour les burgers
    if (isBurger) {
      for (const s of suppProducts) {
        await linkIfMissing(product.id, s.id, parseFloat(SUPPLEMENTS.find(x => x.name === s.name)?.price || 0), false);
      }
      console.log(`    → ${suppProducts.length} suppléments liés (optionnels)`);
    }
  }

  // Cuisson → viandes
  if (isViande) {
    for (const c of cuissonProducts) {
      await linkIfMissing(product.id, c.id, 0, true);
    }
    console.log(`    → ${cuissonProducts.length} options cuisson liées (obligatoires)`);
  }

  linked++;
}

// Résumé
const total = await prisma.productAccompaniment.count({ where: { product: { establishmentId: EST_ID } } });
console.log(`\n══════════════════════════════════════════`);
console.log(`  ${linked} produits configurés`);
console.log(`  ${total} liens total en base`);
console.log(`══════════════════════════════════════════\n`);

await prisma.$disconnect();
