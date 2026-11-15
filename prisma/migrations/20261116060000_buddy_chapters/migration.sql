-- CreateTable
CREATE TABLE "BuddyChapter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "text" TEXT NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "questions" JSONB NOT NULL DEFAULT '[]',
    "model" VARCHAR(100) NOT NULL,
    "costUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuddyChapter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuddyChapter_userId_period_key" ON "BuddyChapter"("userId", "period");

-- AddForeignKey
ALTER TABLE "BuddyChapter" ADD CONSTRAINT "BuddyChapter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

