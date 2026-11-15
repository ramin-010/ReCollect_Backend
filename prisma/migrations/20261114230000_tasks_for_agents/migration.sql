-- Tasks for agents and the @ai task line on Claude (LOOP_COMPLETE_SPEC 4.1).
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentEditKind" ADD VALUE 'task_create';
ALTER TYPE "AgentEditKind" ADD VALUE 'task_update';

-- AlterEnum
ALTER TYPE "AiFeature" ADD VALUE 'task_parse';


-- Tokens that may change learning data may also add and change personal tasks (LOOP_COMPLETE_SPEC 4.1),
-- so Ramin's study chat keeps working without a new token.
UPDATE "ApiToken" SET "scopes" = array_append("scopes", 'tasks:write') WHERE 'learning:write' = ANY("scopes") AND NOT ('tasks:write' = ANY("scopes"));
