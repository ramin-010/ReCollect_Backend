-- AlterTable
ALTER TABLE "Memory" ADD COLUMN     "checkSince" TIMESTAMP(3),
ADD COLUMN     "inferred" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Observation" ADD COLUMN     "basis" VARCHAR(10),
ADD COLUMN     "dayOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updateKind" VARCHAR(10),
ADD COLUMN     "waitingSince" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Observation_userId_waitingSince_idx" ON "Observation"("userId", "waitingSince");

