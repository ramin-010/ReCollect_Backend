-- AlterTable
ALTER TABLE "BuddyCaptureDay" ADD COLUMN     "todayAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BuddyReminder" ADD COLUMN     "origin" VARCHAR(10),
ADD COLUMN     "refId" TEXT,
ADD COLUMN     "refKind" VARCHAR(10);

-- AlterTable
ALTER TABLE "BuddyState" ADD COLUMN     "goalOnScreens" BOOLEAN NOT NULL DEFAULT false;

