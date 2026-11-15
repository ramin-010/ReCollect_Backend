-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AiFeature" ADD VALUE 'buddy_gate';
ALTER TYPE "AiFeature" ADD VALUE 'buddy_digest';
ALTER TYPE "AiFeature" ADD VALUE 'buddy_think';
ALTER TYPE "AiFeature" ADD VALUE 'buddy_pulse';
ALTER TYPE "AiFeature" ADD VALUE 'buddy_check';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SuggestionKind" ADD VALUE 'task';
ALTER TYPE "SuggestionKind" ADD VALUE 'note';
ALTER TYPE "SuggestionKind" ADD VALUE 'decision';
ALTER TYPE "SuggestionKind" ADD VALUE 'routine';

-- AlterEnum
ALTER TYPE "SuggestionProposer" ADD VALUE 'buddy';

-- AlterEnum
ALTER TYPE "SuggestionStatus" ADD VALUE 'candidate';

-- CreateTable
CREATE TABLE "BuddyChunk" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionKey" VARCHAR(80) NOT NULL,
    "seq" INTEGER NOT NULL,
    "project" VARCHAR(100),
    "source" "BuddySource" NOT NULL DEFAULT 'hook',
    "messages" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuddyChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuddyCaptureDay" (
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "seen" INTEGER NOT NULL DEFAULT 0,
    "kept" INTEGER NOT NULL DEFAULT 0,
    "chunks" INTEGER NOT NULL DEFAULT 0,
    "dropped" INTEGER NOT NULL DEFAULT 0,
    "secrets" INTEGER NOT NULL DEFAULT 0,
    "notes" INTEGER NOT NULL DEFAULT 0,
    "items" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BuddyCaptureDay_pkey" PRIMARY KEY ("userId","day")
);

-- CreateIndex
CREATE INDEX "BuddyChunk_createdAt_idx" ON "BuddyChunk"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BuddyChunk_userId_sessionKey_seq_key" ON "BuddyChunk"("userId", "sessionKey", "seq");

-- AddForeignKey
ALTER TABLE "BuddyChunk" ADD CONSTRAINT "BuddyChunk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuddyCaptureDay" ADD CONSTRAINT "BuddyCaptureDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

