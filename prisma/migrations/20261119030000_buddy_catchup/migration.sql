-- CreateTable
CREATE TABLE "BuddyCatchUp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" VARCHAR(20) NOT NULL,
    "firstDay" DATE,
    "lastDay" DATE,
    "notes" INTEGER NOT NULL DEFAULT 0,
    "things" INTEGER NOT NULL DEFAULT 0,
    "batches" INTEGER NOT NULL DEFAULT 0,
    "state" VARCHAR(10) NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BuddyCatchUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuddyCatchUp_userId_startedAt_idx" ON "BuddyCatchUp"("userId", "startedAt");

-- AddForeignKey
ALTER TABLE "BuddyCatchUp" ADD CONSTRAINT "BuddyCatchUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

