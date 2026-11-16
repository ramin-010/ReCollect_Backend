-- CreateEnum
CREATE TYPE "WorkLineSource" AS ENUM ('summary', 'agent');

-- AlterTable
ALTER TABLE "WorkLine" ADD COLUMN     "at" VARCHAR(20),
ADD COLUMN     "source" "WorkLineSource" NOT NULL DEFAULT 'summary';

