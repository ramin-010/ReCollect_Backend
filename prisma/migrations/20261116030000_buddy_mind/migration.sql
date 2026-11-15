-- CreateEnum
CREATE TYPE "BuddyStepKind" AS ENUM ('night', 'pulse');

-- AlterTable
ALTER TABLE "Observation" ADD COLUMN     "foldedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BuddyDay" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "kind" "BuddyStepKind" NOT NULL,
    "lines" JSONB NOT NULL,
    "note" VARCHAR(800),
    "followUp" VARCHAR(300),
    "ops" JSONB NOT NULL DEFAULT '[]',
    "dropped" JSONB NOT NULL DEFAULT '[]',
    "model" VARCHAR(100) NOT NULL,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuddyDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuddyDay_userId_day_idx" ON "BuddyDay"("userId", "day");

-- AddForeignKey
ALTER TABLE "BuddyDay" ADD CONSTRAINT "BuddyDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

