-- AlterTable
ALTER TABLE "BuddyDay" ADD COLUMN     "insight" VARCHAR(200),
ADD COLUMN     "insightLockOk" BOOLEAN NOT NULL DEFAULT false;

