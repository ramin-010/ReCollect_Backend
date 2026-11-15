-- CreateEnum
CREATE TYPE "WeekTargetStatus" AS ENUM ('open', 'done', 'dropped');

-- CreateEnum
CREATE TYPE "WeekMeasure" AS ENUM ('practice', 'minutes', 'topics');

-- CreateEnum
CREATE TYPE "SuggestionKind" AS ENUM ('week_target', 'focus_line', 'profile_edit', 'action');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('pending', 'accepted', 'dismissed');

-- CreateEnum
CREATE TYPE "SuggestionProposer" AS ENUM ('app', 'coach', 'agent', 'ask_ai');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentEditKind" ADD VALUE 'week_target_create';
ALTER TYPE "AgentEditKind" ADD VALUE 'week_target_update';

-- CreateTable
CREATE TABLE "WeekTarget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "text" VARCHAR(140) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "WeekTargetStatus" NOT NULL DEFAULT 'open',
    "doneAt" TIMESTAMP(3),
    "topicId" TEXT,
    "milestoneId" TEXT,
    "todoId" TEXT,
    "measure" "WeekMeasure",
    "amount" INTEGER,
    "subjectId" TEXT,
    "projectId" TEXT,
    "createdBy" "CreatedBy" NOT NULL DEFAULT 'user',
    "agentName" VARCHAR(60),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeekTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suggestion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "SuggestionKind" NOT NULL,
    "text" VARCHAR(200) NOT NULL,
    "reason" VARCHAR(200),
    "payload" JSONB NOT NULL,
    "proposedBy" "SuggestionProposer" NOT NULL,
    "agentName" VARCHAR(60),
    "batch" VARCHAR(40),
    "status" "SuggestionStatus" NOT NULL DEFAULT 'pending',
    "expiresDay" DATE,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WeekTarget_userId_weekStart_idx" ON "WeekTarget"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "Suggestion_userId_status_idx" ON "Suggestion"("userId", "status");

-- CreateIndex
CREATE INDEX "Suggestion_userId_batch_idx" ON "Suggestion"("userId", "batch");

-- AddForeignKey
ALTER TABLE "WeekTarget" ADD CONSTRAINT "WeekTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeekTarget" ADD CONSTRAINT "WeekTarget_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeekTarget" ADD CONSTRAINT "WeekTarget_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "GoalMilestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeekTarget" ADD CONSTRAINT "WeekTarget_todoId_fkey" FOREIGN KEY ("todoId") REFERENCES "Todo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeekTarget" ADD CONSTRAINT "WeekTarget_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeekTarget" ADD CONSTRAINT "WeekTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
