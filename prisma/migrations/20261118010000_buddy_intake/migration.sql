-- AlterTable
ALTER TABLE "AiKeyState" ADD COLUMN     "pausedFrom" TIMESTAMP(3),
ADD COLUMN     "pausedTo" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BuddyCaptureDay" ADD COLUMN     "bySource" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "BuddyChunk" ADD COLUMN     "noteId" VARCHAR(40);

-- CreateTable
CREATE TABLE "BuddySessionMark" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionKey" VARCHAR(80) NOT NULL,
    "readTo" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuddySessionMark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuddySessionMark_userId_sessionKey_key" ON "BuddySessionMark"("userId", "sessionKey");

-- AddForeignKey
ALTER TABLE "BuddySessionMark" ADD CONSTRAINT "BuddySessionMark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

