-- EASY_SETUP_PLAN (11-23): a PC signs in by approval (DeviceSignIn); what is logged in a folder (Project.tracking) and
-- who decided what it is (Project.kindSetBy); who set what a chat is (WorkSession.kindSetBy); the default for new folders
-- (User.newFolders). Additions only.

-- CreateEnum
CREATE TYPE "FolderTracking" AS ENUM ('full', 'light', 'off');

-- CreateEnum
CREATE TYPE "KindSetBy" AS ENUM ('folder', 'pc', 'agent', 'chat', 'app');

-- CreateEnum
CREATE TYPE "NewFolders" AS ENUM ('ask', 'personal', 'study', 'work', 'off');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "kindSetBy" "KindSetBy",
ADD COLUMN     "tracking" "FolderTracking";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "newFolders" "NewFolders" NOT NULL DEFAULT 'ask';

-- AlterTable
ALTER TABLE "WorkSession" ADD COLUMN     "kindSetBy" "KindSetBy" NOT NULL DEFAULT 'folder';

-- CreateTable
CREATE TABLE "DeviceSignIn" (
    "id" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "userCode" VARCHAR(16) NOT NULL,
    "deviceName" VARCHAR(100) NOT NULL,
    "userId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "deniedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "apiTokenId" TEXT,
    "lastPollAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceSignIn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSignIn_deviceCodeHash_key" ON "DeviceSignIn"("deviceCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSignIn_userCode_key" ON "DeviceSignIn"("userCode");

-- CreateIndex
CREATE INDEX "DeviceSignIn_expiresAt_idx" ON "DeviceSignIn"("expiresAt");

-- AddForeignKey
ALTER TABLE "DeviceSignIn" ADD CONSTRAINT "DeviceSignIn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every folder made before this was decided by a PC's rule or the app, so none of them asks.
UPDATE "Project" SET "kindSetBy" = 'pc' WHERE "kindSetBy" IS NULL;
