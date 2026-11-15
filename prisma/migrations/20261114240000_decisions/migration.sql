-- The decision journal (LOOP_COMPLETE_SPEC 4.2).
-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('open', 'reviewed');

-- CreateEnum
CREATE TYPE "DecisionVerdict" AS ENUM ('right', 'wrong', 'mixed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentEditKind" ADD VALUE 'decision_create';
ALTER TYPE "AgentEditKind" ADD VALUE 'decision_update';

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "why" VARCHAR(600) NOT NULL,
    "expect" VARCHAR(400),
    "lookAgainDay" DATE NOT NULL,
    "status" "DecisionStatus" NOT NULL DEFAULT 'open',
    "verdict" "DecisionVerdict",
    "verdictNote" VARCHAR(400),
    "reviewedAt" TIMESTAMP(3),
    "subjectId" TEXT,
    "projectId" TEXT,
    "createdBy" "CreatedBy" NOT NULL DEFAULT 'user',
    "agentName" VARCHAR(60),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Decision_userId_status_lookAgainDay_idx" ON "Decision"("userId", "status", "lookAgainDay");

-- CreateIndex
CREATE INDEX "Decision_projectId_idx" ON "Decision"("projectId");

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

