-- CreateTable
CREATE TABLE "BuddyImport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "fileName" VARCHAR(200),
    "chats" INTEGER NOT NULL DEFAULT 0,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "known" INTEGER NOT NULL DEFAULT 0,
    "pieces" INTEGER NOT NULL DEFAULT 0,
    "estimateUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "limitUsd" DECIMAL(10,4),
    "state" VARCHAR(20) NOT NULL DEFAULT 'estimated',
    "queued" INTEGER NOT NULL DEFAULT 0,
    "oldest" TIMESTAMP(3),
    "newest" TIMESTAMP(3),
    "payload" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuddyImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuddyHeard" (
    "userId" TEXT NOT NULL,
    "chatKey" VARCHAR(120) NOT NULL,
    "fingerprint" VARCHAR(64) NOT NULL,
    "saidAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuddyHeard_pkey" PRIMARY KEY ("userId","chatKey","fingerprint","saidAt")
);

-- CreateIndex
CREATE INDEX "BuddyImport_userId_createdAt_idx" ON "BuddyImport"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "BuddyImport" ADD CONSTRAINT "BuddyImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuddyHeard" ADD CONSTRAINT "BuddyHeard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

