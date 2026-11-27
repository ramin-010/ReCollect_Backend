-- TOOL_ACCESS_PLAN §12 (11-27): what an AI adds it can also take back. Additive: enum values and a nullable column.

-- AlterEnum
ALTER TYPE "AgentEditKind" ADD VALUE 'task_delete';
ALTER TYPE "AgentEditKind" ADD VALUE 'decision_delete';
ALTER TYPE "AgentEditKind" ADD VALUE 'topic_delete';
ALTER TYPE "AgentEditKind" ADD VALUE 'revision_stop';
ALTER TYPE "AgentEditKind" ADD VALUE 'revision_uncomplete';
ALTER TYPE "AgentEditKind" ADD VALUE 'session_update';
ALTER TYPE "AgentEditKind" ADD VALUE 'session_delete';

-- AlterTable
ALTER TABLE "AgentEdit" ADD COLUMN     "undoneBy" VARCHAR(60);
