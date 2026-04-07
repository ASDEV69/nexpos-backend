-- AlterTable: add customerId to tickets for loyalty module
ALTER TABLE "tickets" ADD COLUMN "customerId" TEXT;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
