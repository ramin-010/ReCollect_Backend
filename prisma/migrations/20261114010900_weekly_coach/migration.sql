-- Weekly coach (Phase D3, HOME_DOCS_AGENT_PLAN §4): one row per coach note (five lines on the last
-- 7 days and 3 suggested focus lines). Additive only: one new table, nothing existing changes.
-- Generated with `prisma migrate dev --create-only`.

-- CreateTable
CREATE TABLE "CoachNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "weekEnd" DATE NOT NULL,
    "lines" JSONB NOT NULL,
    "focus" JSONB NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoachNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoachNote_userId_createdAt_idx" ON "CoachNote"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "CoachNote" ADD CONSTRAINT "CoachNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
