-- CreateTable
CREATE TABLE "BuddyOutcome" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "shown" VARCHAR(12) NOT NULL,
    "text" VARCHAR(200) NOT NULL,
    "about" JSONB NOT NULL DEFAULT '[]',
    "fromAt" TIMESTAMP(3),
    "untilAt" TIMESTAMP(3),
    "outcome" VARCHAR(12) NOT NULL,
    "minutes" INTEGER,
    "sourceKey" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuddyOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuddyOutcome_userId_day_idx" ON "BuddyOutcome"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "BuddyOutcome_userId_sourceKey_key" ON "BuddyOutcome"("userId", "sourceKey");

-- AddForeignKey
ALTER TABLE "BuddyOutcome" ADD CONSTRAINT "BuddyOutcome_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

