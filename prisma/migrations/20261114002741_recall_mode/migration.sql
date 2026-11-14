-- Recall mode (Phase D, HOME_DOCS_AGENT_PLAN §4): question sets per revision (RecallSet), answers
-- (RecallAttempt), the AI spend meter (AiUsage), the monthly cap (AiSettings) and the nightly
-- Message Batches (AiBatch). Additive only: new enums and new tables, nothing existing changes.
-- Generated with `prisma migrate dev --create-only`.

-- CreateEnum
CREATE TYPE "RecallSetStatus" AS ENUM ('pending', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "RecallGrade" AS ENUM ('strong', 'partial', 'weak');

-- CreateEnum
CREATE TYPE "RecallSelfMark" AS ENUM ('knew', 'didnt');

-- CreateEnum
CREATE TYPE "AiFeature" AS ENUM ('recall_questions', 'recall_grade', 'practice_note', 'weekly_coach');

-- CreateTable
CREATE TABLE "RecallSet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "docId" TEXT,
    "cycleNumber" INTEGER NOT NULL,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "status" "RecallSetStatus" NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "batchId" VARCHAR(100),
    "error" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "result" "RecallGrade",
    "outcome" JSONB,

    CONSTRAINT "RecallSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecallAttempt" (
    "id" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "questionId" VARCHAR(20) NOT NULL,
    "answer" TEXT,
    "selfMark" "RecallSelfMark",
    "grade" "RecallGrade" NOT NULL,
    "feedback" TEXT NOT NULL DEFAULT '',
    "quote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecallAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "batch" BOOLEAN NOT NULL DEFAULT false,
    "costUsd" DECIMAL(10,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSettings" (
    "userId" TEXT NOT NULL,
    "monthlyCapUsd" DECIMAL(10,2) NOT NULL DEFAULT 20,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AiBatch" (
    "id" VARCHAR(100) NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "owners" JSONB NOT NULL DEFAULT '{}',
    "requestCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "summary" VARCHAR(300),

    CONSTRAINT "AiBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecallSet_revisionId_finishedAt_idx" ON "RecallSet"("revisionId", "finishedAt");

-- CreateIndex
CREATE INDEX "RecallSet_userId_createdAt_idx" ON "RecallSet"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RecallSet_batchId_idx" ON "RecallSet"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "RecallAttempt_setId_questionId_key" ON "RecallAttempt"("setId", "questionId");

-- CreateIndex
CREATE INDEX "AiUsage_userId_createdAt_idx" ON "AiUsage"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiBatch_endedAt_idx" ON "AiBatch"("endedAt");

-- AddForeignKey
ALTER TABLE "RecallSet" ADD CONSTRAINT "RecallSet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecallSet" ADD CONSTRAINT "RecallSet_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "Revision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecallSet" ADD CONSTRAINT "RecallSet_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecallAttempt" ADD CONSTRAINT "RecallAttempt_setId_fkey" FOREIGN KEY ("setId") REFERENCES "RecallSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSettings" ADD CONSTRAINT "AiSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
