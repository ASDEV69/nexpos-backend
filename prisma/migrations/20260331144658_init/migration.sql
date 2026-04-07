-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'CASHIER', 'WAITER');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('SINGLE', 'MENU');

-- CreateEnum
CREATE TYPE "TableStatus" AS ENUM ('FREE', 'OCCUPIED', 'WAITING', 'RESERVED', 'CLEANING');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'SENT', 'READY', 'PAID', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderMode" AS ENUM ('DINE_IN', 'TAKEAWAY', 'DELIVERY', 'KIOSK');

-- CreateEnum
CREATE TYPE "TicketSource" AS ENUM ('CASHIER', 'WAITER', 'KIOSK', 'UBER_EATS', 'DELIVEROO', 'JUST_EAT', 'GLOVO');

-- CreateEnum
CREATE TYPE "ClosureType" AS ENUM ('DAILY', 'MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "StockMoveType" AS ENUM ('SALE', 'PURCHASE', 'ADJUSTMENT', 'WASTE', 'TRANSFER');

-- CreateEnum
CREATE TYPE "DeliveryPlatform" AS ENUM ('UBER_EATS', 'DELIVEROO', 'JUST_EAT', 'GLOVO');

-- CreateTable
CREATE TABLE "establishments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "siret" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "zipCode" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'FR',
    "vatNumber" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "logo" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "licenseKey" TEXT,
    "licenseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "establishments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "initial" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'WAITER',
    "pin" TEXT NOT NULL,
    "email" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tva_rates" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tva_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT '🍽️',
    "color" TEXT NOT NULL DEFAULT '#4f7bff',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "tvaRateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "emoji" TEXT NOT NULL DEFAULT '🍽️',
    "color" TEXT NOT NULL DEFAULT '#4f7bff',
    "img" TEXT,
    "trEligible" BOOLEAN NOT NULL DEFAULT false,
    "type" "ProductType" NOT NULL DEFAULT 'SINGLE',
    "barcode" TEXT,
    "stockEnabled" BOOLEAN NOT NULL DEFAULT false,
    "stockQty" DECIMAL(10,3),
    "stockAlert" DECIMAL(10,3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menus" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "emoji" TEXT NOT NULL DEFAULT '🍱',
    "color" TEXT NOT NULL DEFAULT '#f472b6',
    "img" TEXT,
    "basePrice" DECIMAL(10,2) NOT NULL,
    "tva" DECIMAL(5,2) NOT NULL,
    "trEligible" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_steps" (
    "id" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT '🍽️',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "minChoice" INTEGER NOT NULL DEFAULT 1,
    "maxChoice" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "menu_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_choices" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "priceExtra" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "menu_choices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tables" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "section" TEXT DEFAULT 'Salle principale',
    "covers" INTEGER NOT NULL DEFAULT 0,
    "status" "TableStatus" NOT NULL DEFAULT 'FREE',
    "posX" INTEGER NOT NULL DEFAULT 0,
    "posY" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_modes" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT '💳',
    "trAllowed" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_modes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tableId" TEXT,
    "number" INTEGER NOT NULL,
    "orderMode" "OrderMode" NOT NULL DEFAULT 'DINE_IN',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "covers" INTEGER NOT NULL DEFAULT 1,
    "totalHt" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalTva" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalTtc" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discountType" TEXT,
    "discountValue" DECIMAL(10,2),
    "discountAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "finalAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "hash" TEXT,
    "prevHash" TEXT,
    "signedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledById" TEXT,
    "parentTicketId" TEXT,
    "note" TEXT,
    "source" "TicketSource" NOT NULL DEFAULT 'CASHIER',
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_lines" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "productId" TEXT,
    "menuId" TEXT,
    "tvaRateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "qty" DECIMAL(10,3) NOT NULL,
    "unitPriceHt" DECIMAL(10,4) NOT NULL,
    "unitPriceTtc" DECIMAL(10,2) NOT NULL,
    "tvaRate" DECIMAL(5,2) NOT NULL,
    "totalHt" DECIMAL(10,2) NOT NULL,
    "totalTva" DECIMAL(10,2) NOT NULL,
    "totalTtc" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "trEligible" BOOLEAN NOT NULL DEFAULT false,
    "menuComposition" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_tva" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "baseHt" DECIMAL(10,2) NOT NULL,
    "tvaAmt" DECIMAL(10,2) NOT NULL,
    "totalTtc" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "ticket_tva_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "paymentModeId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "cashGiven" DECIMAL(10,2),
    "cashChange" DECIMAL(10,2),
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closures" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "type" "ClosureType" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "ticketCount" INTEGER NOT NULL,
    "cancelCount" INTEGER NOT NULL DEFAULT 0,
    "totalHt" DECIMAL(12,2) NOT NULL,
    "totalTva" DECIMAL(12,2) NOT NULL,
    "totalTtc" DECIMAL(12,2) NOT NULL,
    "hash" TEXT NOT NULL,
    "prevHash" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "softwareVersion" TEXT NOT NULL DEFAULT '2.0.0',
    "tvaBreakdown" JSONB NOT NULL,
    "payBreakdown" JSONB NOT NULL,

    CONSTRAINT "closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "StockMoveType" NOT NULL,
    "qty" DECIMAL(10,3) NOT NULL,
    "reason" TEXT,
    "reference" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_integrations" (
    "id" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "platform" "DeliveryPlatform" NOT NULL,
    "apiKey" TEXT,
    "webhookSecret" TEXT,
    "restaurantId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "establishments_siret_key" ON "establishments"("siret");

-- CreateIndex
CREATE UNIQUE INDEX "users_establishmentId_email_key" ON "users"("establishmentId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE UNIQUE INDEX "tva_rates_establishmentId_rate_key" ON "tva_rates"("establishmentId", "rate");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_integrations_establishmentId_platform_key" ON "delivery_integrations"("establishmentId", "platform");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tva_rates" ADD CONSTRAINT "tva_rates_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tvaRateId_fkey" FOREIGN KEY ("tvaRateId") REFERENCES "tva_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menus" ADD CONSTRAINT "menus_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_steps" ADD CONSTRAINT "menu_steps_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "menus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_choices" ADD CONSTRAINT "menu_choices_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "menu_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_choices" ADD CONSTRAINT "menu_choices_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_modes" ADD CONSTRAINT "payment_modes_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "menus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_lines" ADD CONSTRAINT "ticket_lines_tvaRateId_fkey" FOREIGN KEY ("tvaRateId") REFERENCES "tva_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_tva" ADD CONSTRAINT "ticket_tva_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_paymentModeId_fkey" FOREIGN KEY ("paymentModeId") REFERENCES "payment_modes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closures" ADD CONSTRAINT "closures_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_establishmentId_fkey" FOREIGN KEY ("establishmentId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
