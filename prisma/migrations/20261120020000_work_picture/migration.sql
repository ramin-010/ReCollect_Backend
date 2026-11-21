-- AlterTable
ALTER TABLE "BuddyState" ADD COLUMN     "shareOfficeWork" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "WorkLine" ADD COLUMN     "app" VARCHAR(60),
ADD COLUMN     "followsId" TEXT,
ADD COLUMN     "happenedAt" TIMESTAMP(3),
ADD COLUMN     "sameAsId" TEXT;

-- CreateIndex
CREATE INDEX "WorkLine_followsId_idx" ON "WorkLine"("followsId");

-- CreateIndex
CREATE INDEX "WorkLine_sameAsId_idx" ON "WorkLine"("sameAsId");

-- AddForeignKey
ALTER TABLE "WorkLine" ADD CONSTRAINT "WorkLine_followsId_fkey" FOREIGN KEY ("followsId") REFERENCES "WorkLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkLine" ADD CONSTRAINT "WorkLine_sameAsId_fkey" FOREIGN KEY ("sameAsId") REFERENCES "WorkLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

