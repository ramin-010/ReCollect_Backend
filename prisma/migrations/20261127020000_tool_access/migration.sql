-- TOOL_ACCESS_PLAN (11-27): additions only. Chats may read their pocket notes when the person allows it (off by
-- default); the agent edits for pocket notes, subjects and files on notes; tool calls counted per day (no user data).

-- AlterEnum
ALTER TYPE "AgentEditKind" ADD VALUE 'pocket_update';
ALTER TYPE "AgentEditKind" ADD VALUE 'pocket_delete';
ALTER TYPE "AgentEditKind" ADD VALUE 'subject_update';
ALTER TYPE "AgentEditKind" ADD VALUE 'subject_delete';
ALTER TYPE "AgentEditKind" ADD VALUE 'note_file_add';
ALTER TYPE "AgentEditKind" ADD VALUE 'note_file_remove';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pocketForAgents" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "McpToolStat" (
    "day" VARCHAR(10) NOT NULL,
    "door" VARCHAR(12) NOT NULL,
    "app" VARCHAR(60) NOT NULL,
    "tool" VARCHAR(60) NOT NULL,
    "via" VARCHAR(16) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "msTotal" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "McpToolStat_pkey" PRIMARY KEY ("day","door","app","tool","via","outcome")
);
