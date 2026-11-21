-- AlterTable
ALTER TABLE "AiUsage" ADD COLUMN     "source" VARCHAR(10) NOT NULL DEFAULT 'house';

-- CreateTable
CREATE TABLE "AiKeyState" (
    "keyId" VARCHAR(64) NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'ok',
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" VARCHAR(300),
    "probeAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiKeyState_pkey" PRIMARY KEY ("keyId")
);

