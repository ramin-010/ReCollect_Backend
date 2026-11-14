-- Agents (Phase C1, HOME_DOCS_AGENT_PLAN §3): personal access tokens, the agent edit log, doc
-- snapshots for Undo, Idempotency-Key replay, and createdBy/agentName provenance on goals,
-- milestones and focus lines. Additive only: new enums, new tables, and new columns whose defaults
-- ('user', NULL) describe every existing row. Generated with `prisma migrate dev --create-only`.

-- CreateEnum
CREATE TYPE "CreatedBy" AS ENUM ('user', 'agent');

-- CreateEnum
CREATE TYPE "AgentEditKind" AS ENUM ('doc_create', 'doc_append', 'doc_replace_section', 'goal_create', 'goal_update', 'milestone_add', 'milestone_update', 'focus_add', 'pocket_add', 'revision_schedule', 'subject_create');

-- AlterTable
ALTER TABLE "FocusItem" ADD COLUMN     "agentName" VARCHAR(60),
ADD COLUMN     "createdBy" "CreatedBy" NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "Goal" ADD COLUMN     "agentName" VARCHAR(60),
ADD COLUMN     "createdBy" "CreatedBy" NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "GoalMilestone" ADD COLUMN     "agentName" VARCHAR(60),
ADD COLUMN     "createdBy" "CreatedBy" NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" VARCHAR(12) NOT NULL,
    "scopes" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocSnapshot" (
    "id" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "yjsState" TEXT NOT NULL,
    "agentUpdate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEdit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT,
    "docId" TEXT,
    "kind" "AgentEditKind" NOT NULL,
    "agentName" VARCHAR(60) NOT NULL,
    "summary" VARCHAR(300) NOT NULL,
    "snapshotId" TEXT,
    "entityId" TEXT,
    "undoData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "seenAt" TIMESTAMP(3),

    CONSTRAINT "AgentEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "statusCode" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_userId_createdAt_idx" ON "ApiToken"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DocSnapshot_docId_createdAt_idx" ON "DocSnapshot"("docId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentEdit_userId_createdAt_idx" ON "AgentEdit"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AgentEdit_docId_idx" ON "AgentEdit"("docId");

-- CreateIndex
CREATE INDEX "AgentEdit_snapshotId_idx" ON "AgentEdit"("snapshotId");

-- CreateIndex
CREATE INDEX "AgentEdit_tokenId_idx" ON "AgentEdit"("tokenId");

-- CreateIndex
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_userId_key_key" ON "IdempotencyKey"("userId", "key");

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocSnapshot" ADD CONSTRAINT "DocSnapshot_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEdit" ADD CONSTRAINT "AgentEdit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEdit" ADD CONSTRAINT "AgentEdit_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "ApiToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEdit" ADD CONSTRAINT "AgentEdit_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEdit" ADD CONSTRAINT "AgentEdit_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "DocSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
