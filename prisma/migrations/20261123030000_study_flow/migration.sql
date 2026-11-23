-- STUDY_FLOW_PLAN (11-23): additions only. A doc's revision card (the heading block that starts it) and who wrote
-- a note (a chat's note says "from <app>" in the doc's sidebar).

-- AlterTable
ALTER TABLE "Capture" ADD COLUMN     "agentName" VARCHAR(60),
ADD COLUMN     "createdBy" "CreatedBy" NOT NULL DEFAULT 'user';

-- AlterTable
ALTER TABLE "Doc" ADD COLUMN     "cardBlockId" TEXT;
