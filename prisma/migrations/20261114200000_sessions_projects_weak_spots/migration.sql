-- SYNC_SPINE_SPEC 1.2: the record. WorkSession (one per piece of work, written by agents, hooks or
-- by hand), Project (where build sessions belong), WeakSpot (from study chats to Recall and back).
-- Additive. Tokens that could write learning data get the new sessions:write scope, so a study
-- chat's token keeps working.

-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('study', 'practice', 'build', 'review');

-- CreateEnum
CREATE TYPE "PracticeOutcome" AS ENUM ('alone', 'hints', 'after_answer');

-- CreateEnum
CREATE TYPE "SessionSource" AS ENUM ('agent', 'hook', 'user');

-- CreateEnum
CREATE TYPE "WeakSpotStatus" AS ENUM ('open', 'cleared');

-- CreateEnum
CREATE TYPE "WeakSpotSource" AS ENUM ('session', 'recall');

-- CreateTable
CREATE TABLE "WorkSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" VARCHAR(80),
    "kind" "SessionKind" NOT NULL DEFAULT 'study',
    "day" DATE NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "minutes" INTEGER,
    "subjectId" TEXT,
    "topicId" TEXT,
    "projectId" TEXT,
    "title" VARCHAR(200) NOT NULL,
    "scoreDone" INTEGER,
    "scoreTotal" INTEGER,
    "outcome" "PracticeOutcome",
    "problem" VARCHAR(200),
    "url" VARCHAR(500),
    "nextStep" VARCHAR(300),
    "details" JSONB,
    "source" "SessionSource" NOT NULL DEFAULT 'user',
    "agentName" VARCHAR(60),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "goalId" TEXT,
    "nextStep" VARCHAR(300),
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeakSpot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topicId" TEXT,
    "subjectId" TEXT,
    "text" VARCHAR(160) NOT NULL,
    "textKey" VARCHAR(160) NOT NULL,
    "status" "WeakSpotStatus" NOT NULL DEFAULT 'open',
    "source" "WeakSpotSource" NOT NULL DEFAULT 'session',
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),

    CONSTRAINT "WeakSpot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkSession_userId_day_idx" ON "WorkSession"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "WorkSession_userId_key_key" ON "WorkSession"("userId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Project_userId_key_key" ON "Project"("userId", "key");

-- CreateIndex
CREATE INDEX "WeakSpot_userId_status_idx" ON "WeakSpot"("userId", "status");

-- CreateIndex
CREATE INDEX "WeakSpot_subjectId_idx" ON "WeakSpot"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "WeakSpot_userId_topicId_textKey_key" ON "WeakSpot"("userId", "topicId", "textKey");

-- AddForeignKey
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeakSpot" ADD CONSTRAINT "WeakSpot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeakSpot" ADD CONSTRAINT "WeakSpot_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeakSpot" ADD CONSTRAINT "WeakSpot_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeakSpot" ADD CONSTRAINT "WeakSpot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tokens: sessions:write for every token that has learning:write.
UPDATE "ApiToken" SET "scopes" = array_append("scopes", 'sessions:write')
WHERE 'learning:write' = ANY("scopes") AND NOT ('sessions:write' = ANY("scopes"));
