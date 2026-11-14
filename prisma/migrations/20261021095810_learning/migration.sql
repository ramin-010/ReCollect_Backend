-- CreateEnum
CREATE TYPE "RoutineMode" AS ENUM ('MASTER', 'DAILY');

-- CreateEnum
CREATE TYPE "RevisionStatus" AS ENUM ('pending', 'done', 'missed');

-- CreateEnum
CREATE TYPE "CaptureType" AS ENUM ('NOTE', 'LINK');

-- CreateEnum
CREATE TYPE "GoalType" AS ENUM ('NONE', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('UPCOMING', 'ACTIVE', 'COMPLETED', 'SKIPPED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "BlockLogStatus" AS ENUM ('COMPLETED', 'SKIPPED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "QuickNoteCategory" AS ENUM ('PRIMARY', 'TEMPORARY');

-- AlterTable
ALTER TABLE "Todo" ADD COLUMN     "goalType" "GoalType" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "globalStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "globalStreakBeforeCredit" JSONB,
ADD COLUMN     "lastGlobalStreakDay" DATE,
ADD COLUMN     "learningRolledOverDay" DATE,
ADD COLUMN     "longestGlobalStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "routineMode" "RoutineMode" NOT NULL DEFAULT 'MASTER',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';

-- CreateTable
CREATE TABLE "Subject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "docId" TEXT,
    "title" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" DOUBLE PRECISION,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "legacyCanvas" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Capture" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "CaptureType" NOT NULL DEFAULT 'NOTE',
    "title" TEXT,
    "content" TEXT,
    "url" TEXT,
    "cloudPublicId" TEXT,
    "fileType" TEXT,
    "category" TEXT,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "subjectId" TEXT,
    "topicId" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Capture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Revision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topicId" TEXT,
    "captureId" TEXT,
    "cycleNumber" INTEGER NOT NULL,
    "intervalDays" INTEGER NOT NULL,
    "scheduledFor" DATE NOT NULL,
    "completedAt" TIMESTAMP(3),
    "status" "RevisionStatus" NOT NULL DEFAULT 'pending',
    "undo" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubjectStreak" (
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastCreditDay" DATE,
    "beforeLastCredit" JSONB,

    CONSTRAINT "SubjectStreak_pkey" PRIMARY KEY ("userId","subjectId")
);

-- CreateTable
CREATE TABLE "DailyHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "revisionsDue" INTEGER NOT NULL,
    "revisionsDone" INTEGER NOT NULL,
    "streakMaintained" BOOLEAN NOT NULL,

    CONSTRAINT "DailyHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeBlock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "date" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockSessionLog" (
    "id" TEXT NOT NULL,
    "timeBlockId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "BlockLogStatus" NOT NULL,
    "remark" TEXT,
    "minutesDone" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockSessionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyScheduleSlot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceBlockId" TEXT,
    "date" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "status" "SlotStatus" NOT NULL DEFAULT 'UPCOMING',
    "actualStartTime" TEXT,
    "actualEndTime" TEXT,
    "remark" TEXT,
    "minutesDone" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyScheduleSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DayDebrief" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "blocksPlanned" INTEGER NOT NULL DEFAULT 0,
    "blocksCompleted" INTEGER NOT NULL DEFAULT 0,
    "blocksSkipped" INTEGER NOT NULL DEFAULT 0,
    "totalFocusedMin" INTEGER NOT NULL DEFAULT 0,
    "energy" INTEGER,
    "focus" INTEGER,
    "mood" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "narrative" TEXT,
    "tomorrowIntent" TEXT,
    "freeWrite" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DayDebrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuickNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "category" "QuickNoteCategory" NOT NULL DEFAULT 'PRIMARY',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subject_userId_createdAt_idx" ON "Subject"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Topic_subjectId_idx" ON "Topic"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "Topic_userId_docId_key" ON "Topic"("userId", "docId");

-- CreateIndex
CREATE INDEX "Capture_userId_subjectId_createdAt_idx" ON "Capture"("userId", "subjectId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Capture_topicId_idx" ON "Capture"("topicId");

-- CreateIndex
CREATE INDEX "Revision_userId_status_scheduledFor_idx" ON "Revision"("userId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "Revision_userId_completedAt_idx" ON "Revision"("userId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Revision_topicId_cycleNumber_key" ON "Revision"("topicId", "cycleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Revision_captureId_cycleNumber_key" ON "Revision"("captureId", "cycleNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DailyHistory_userId_subjectId_date_key" ON "DailyHistory"("userId", "subjectId", "date");

-- CreateIndex
CREATE INDEX "TimeBlock_userId_idx" ON "TimeBlock"("userId");

-- CreateIndex
CREATE INDEX "BlockSessionLog_date_idx" ON "BlockSessionLog"("date");

-- CreateIndex
CREATE UNIQUE INDEX "BlockSessionLog_timeBlockId_date_key" ON "BlockSessionLog"("timeBlockId", "date");

-- CreateIndex
CREATE INDEX "DailyScheduleSlot_userId_date_idx" ON "DailyScheduleSlot"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyScheduleSlot_sourceBlockId_date_key" ON "DailyScheduleSlot"("sourceBlockId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DayDebrief_userId_date_key" ON "DayDebrief"("userId", "date");

-- CreateIndex
CREATE INDEX "QuickNote_userId_createdAt_idx" ON "QuickNote"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Topic" ADD CONSTRAINT "Topic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Topic" ADD CONSTRAINT "Topic_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Topic" ADD CONSTRAINT "Topic_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "Capture"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectStreak" ADD CONSTRAINT "SubjectStreak_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectStreak" ADD CONSTRAINT "SubjectStreak_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyHistory" ADD CONSTRAINT "DailyHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyHistory" ADD CONSTRAINT "DailyHistory_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeBlock" ADD CONSTRAINT "TimeBlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockSessionLog" ADD CONSTRAINT "BlockSessionLog_timeBlockId_fkey" FOREIGN KEY ("timeBlockId") REFERENCES "TimeBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyScheduleSlot" ADD CONSTRAINT "DailyScheduleSlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyScheduleSlot" ADD CONSTRAINT "DailyScheduleSlot_sourceBlockId_fkey" FOREIGN KEY ("sourceBlockId") REFERENCES "TimeBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayDebrief" ADD CONSTRAINT "DayDebrief_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuickNote" ADD CONSTRAINT "QuickNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one of topicId / captureId is set on a revision (LEARNING_SPEC §1).
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_exactly_one_item"
  CHECK (("topicId" IS NULL) <> ("captureId" IS NULL));
