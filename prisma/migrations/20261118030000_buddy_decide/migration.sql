-- AlterTable
ALTER TABLE "BuddyAsk" ADD COLUMN     "thumb" VARCHAR(10);

-- AlterTable
ALTER TABLE "BuddyState" ADD COLUMN     "asksOn" BOOLEAN NOT NULL DEFAULT true;

