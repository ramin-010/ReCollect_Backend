-- STUDY_FLOW_PLAN §4.5 (11-23): an addition only. Building their own projects counts as progress (learning always does);
-- on by default, as it did before the choice.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "progressIncludesBuilding" BOOLEAN NOT NULL DEFAULT true;

