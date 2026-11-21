-- AlterTable
ALTER TABLE "BuddyAsk" ADD COLUMN     "thumbReason" VARCHAR(12);

-- AlterTable
ALTER TABLE "BuddyFeedback" ADD COLUMN     "reason" VARCHAR(12),
ADD COLUMN     "words" VARCHAR(200);

-- AlterTable
ALTER TABLE "BuddyThread" ADD COLUMN     "event" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "eventMinute" INTEGER;

-- CreateTable
CREATE TABLE "BuddyScreenRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "threadId" TEXT,
    "fromMin" INTEGER,
    "days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "text" VARCHAR(200) NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "BuddyScreenRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuddyScreenRule_userId_endedAt_idx" ON "BuddyScreenRule"("userId", "endedAt");

-- AddForeignKey
ALTER TABLE "BuddyScreenRule" ADD CONSTRAINT "BuddyScreenRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

