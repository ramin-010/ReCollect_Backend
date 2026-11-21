-- AlterTable
ALTER TABLE "Reminder" ADD COLUMN     "repeat" VARCHAR(20),
ADD COLUMN     "seriesId" TEXT,
ADD COLUMN     "silent" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LockPin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" VARCHAR(120) NOT NULL,
    "fromMin" INTEGER NOT NULL,
    "toMin" INTEGER NOT NULL,
    "days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "untilDay" DATE,
    "setBy" VARCHAR(20) NOT NULL,
    "agentName" VARCHAR(60),
    "clearedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LockPin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LockPin_userId_clearedAt_idx" ON "LockPin"("userId", "clearedAt");

-- CreateIndex
CREATE INDEX "Reminder_seriesId_idx" ON "Reminder"("seriesId");

-- AddForeignKey
ALTER TABLE "LockPin" ADD CONSTRAINT "LockPin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

