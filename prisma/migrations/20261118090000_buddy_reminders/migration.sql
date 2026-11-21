-- CreateTable
CREATE TABLE "BuddyReminder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT,
    "text" VARCHAR(120) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "repeat" VARCHAR(20),
    "buddyDayId" TEXT,
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuddyReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuddyReminder_userId_at_idx" ON "BuddyReminder"("userId", "at");

-- AddForeignKey
ALTER TABLE "BuddyReminder" ADD CONSTRAINT "BuddyReminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuddyReminder" ADD CONSTRAINT "BuddyReminder_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "BuddyThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

