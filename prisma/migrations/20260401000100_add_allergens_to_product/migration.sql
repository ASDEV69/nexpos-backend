-- AddColumn allergens
ALTER TABLE "products" ADD COLUMN "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[];
