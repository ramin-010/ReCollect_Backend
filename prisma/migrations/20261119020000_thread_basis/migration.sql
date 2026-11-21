-- AlterTable
ALTER TABLE "BuddyThreadEvent" ADD COLUMN     "basis" VARCHAR(10),
ADD COLUMN     "dayOnly" BOOLEAN NOT NULL DEFAULT false;

