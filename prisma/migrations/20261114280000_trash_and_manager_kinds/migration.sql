-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentEditKind" ADD VALUE 'doc_trash';
ALTER TYPE "AgentEditKind" ADD VALUE 'doc_restore';
ALTER TYPE "AgentEditKind" ADD VALUE 'revision_complete';
ALTER TYPE "AgentEditKind" ADD VALUE 'revision_reschedule';
ALTER TYPE "AgentEditKind" ADD VALUE 'settings_update';
ALTER TYPE "AgentEditKind" ADD VALUE 'project_update';

-- AlterEnum
ALTER TYPE "AiFeature" ADD VALUE 'assistant';

-- AlterTable
ALTER TABLE "Doc" ADD COLUMN     "trashedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Doc_trashedAt_idx" ON "Doc"("trashedAt");

