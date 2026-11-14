-- Drop the whiteboard (drawings) module: tables "DrawingCollaborator" and "Drawing", and the
-- 'drawing' value of the enum "RecentVisitItemType". The code and the removed schema are in
-- backend/_archive/drawing. Data loss (approved): every drawing, its collaborators and the recent
-- visits of drawings.
--
-- Generated with `prisma migrate diff`, then edited by hand:
--   1. delete the recent visits of drawings BEFORE the enum loses 'drawing' (the cast below would
--      fail on them),
--   2. drop "DrawingCollaborator", then "Drawing",
--   3. recreate the enum without 'drawing' (Prisma's usual swap),
-- all in ONE transaction (Prisma put only the enum swap in BEGIN/COMMIT), so a failure anywhere
-- leaves the database exactly as it was.

BEGIN;

-- 1. Recent visits of drawings. The lock stops an API process still running the old code from
--    recording a new drawing visit between this DELETE and the enum swap (the table is small).
LOCK TABLE "RecentVisit" IN ACCESS EXCLUSIVE MODE;
DELETE FROM "RecentVisit" WHERE "itemType" = 'drawing';

-- 2. DropForeignKey
ALTER TABLE "DrawingCollaborator" DROP CONSTRAINT "DrawingCollaborator_drawingId_fkey";
ALTER TABLE "DrawingCollaborator" DROP CONSTRAINT "DrawingCollaborator_userId_fkey";
ALTER TABLE "Drawing" DROP CONSTRAINT "Drawing_userId_fkey";

-- DropTable (their indexes go with them)
DROP TABLE "DrawingCollaborator";
DROP TABLE "Drawing";

-- 3. AlterEnum: "RecentVisit"."itemType" is the only column of this type and has no default.
CREATE TYPE "RecentVisitItemType_new" AS ENUM ('doc', 'slide', 'workspace');
ALTER TABLE "RecentVisit" ALTER COLUMN "itemType" TYPE "RecentVisitItemType_new" USING ("itemType"::text::"RecentVisitItemType_new");
ALTER TYPE "RecentVisitItemType" RENAME TO "RecentVisitItemType_old";
ALTER TYPE "RecentVisitItemType_new" RENAME TO "RecentVisitItemType";
DROP TYPE "public"."RecentVisitItemType_old";

COMMIT;
