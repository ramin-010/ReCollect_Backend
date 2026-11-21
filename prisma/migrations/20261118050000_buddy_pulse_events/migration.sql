-- AlterTable
ALTER TABLE "BuddyCaptureDay" ADD COLUMN     "pulseSkippedAt" TIMESTAMP(3),
ADD COLUMN     "pulsesSkipped" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BuddyDay" ADD COLUMN     "onEvent" BOOLEAN NOT NULL DEFAULT false;

