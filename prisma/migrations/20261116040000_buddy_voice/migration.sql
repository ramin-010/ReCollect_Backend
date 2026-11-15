-- CreateTable
CREATE TABLE "BuddyFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "buddyDayId" TEXT NOT NULL,
    "target" VARCHAR(20) NOT NULL,
    "verdict" VARCHAR(10) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuddyFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuddyFeedback_userId_createdAt_idx" ON "BuddyFeedback"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "BuddyFeedback" ADD CONSTRAINT "BuddyFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

