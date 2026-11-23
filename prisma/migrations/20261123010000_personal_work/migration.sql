-- PERSONAL_OFFICE_PLAN (11-23): a folder's kind (personal, study, work), a session's area (personal, work) and the
-- person's choice of what counts as progress. Additions only; the backfill below marks work what was already office.

-- CreateEnum
CREATE TYPE "SessionArea" AS ENUM ('personal', 'work');

-- CreateEnum
CREATE TYPE "ProjectKind" AS ENUM ('personal', 'study', 'work');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "kind" "ProjectKind" NOT NULL DEFAULT 'personal';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "progressIncludesWork" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WorkSession" ADD COLUMN     "area" "SessionArea" NOT NULL DEFAULT 'personal';

-- CreateIndex
CREATE INDEX "WorkSession_userId_area_day_idx" ON "WorkSession"("userId", "area", "day");

-- Backfill: a folder whose work log lines were marked office (a work folder on the PC, `brief: false`) is a work
-- folder, and its sessions are work.
UPDATE "Project" p
SET "kind" = 'work'
WHERE EXISTS (
    SELECT 1 FROM "WorkLine" w
    WHERE w."userId" = p."userId" AND w."project" = p."key" AND w."office" = true
);

UPDATE "WorkSession" s
SET "area" = 'work'
FROM "Project" p
WHERE s."projectId" = p."id" AND p."kind" = 'work';
