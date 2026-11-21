-- AlterTable
ALTER TABLE "User" ADD COLUMN     "plan" VARCHAR(12) NOT NULL DEFAULT 'free';

-- CreateTable
CREATE TABLE "AiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" VARCHAR(20) NOT NULL DEFAULT 'anthropic',
    "cipher" TEXT NOT NULL,
    "iv" VARCHAR(32) NOT NULL,
    "tag" VARCHAR(32) NOT NULL,
    "last4" VARCHAR(4) NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "AiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiKey_userId_removedAt_idx" ON "AiKey"("userId", "removedAt");

-- AddForeignKey
ALTER TABLE "AiKey" ADD CONSTRAINT "AiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

