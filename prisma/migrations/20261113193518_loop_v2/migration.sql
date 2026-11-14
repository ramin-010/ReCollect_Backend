-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('active', 'done', 'archived');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "busyUntil" DATE,
ADD COLUMN     "dailyBudgetMin" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN     "lastNudgeDay" DATE,
ADD COLUMN     "lastSeenDay" DATE,
ADD COLUMN     "nudgeEmailEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "nudgeTime" TEXT NOT NULL DEFAULT '08:30',
ADD COLUMN     "prevSeenDay" DATE,
ADD COLUMN     "routineEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FocusItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "text" VARCHAR(140) NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FocusItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "why" VARCHAR(500),
    "deadline" DATE NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoalSubject" (
    "goalId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalSubject_pkey" PRIMARY KEY ("goalId","subjectId")
);

-- CreateTable
CREATE TABLE "GoalMilestone" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "title" VARCHAR(140) NOT NULL,
    "dueDay" DATE,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GoalMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FocusItem_userId_day_idx" ON "FocusItem"("userId", "day");

-- CreateIndex
CREATE INDEX "Goal_userId_status_idx" ON "Goal"("userId", "status");

-- CreateIndex
CREATE INDEX "GoalSubject_subjectId_idx" ON "GoalSubject"("subjectId");

-- CreateIndex
CREATE INDEX "GoalMilestone_goalId_sortOrder_idx" ON "GoalMilestone"("goalId", "sortOrder");

-- AddForeignKey
ALTER TABLE "FocusItem" ADD CONSTRAINT "FocusItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalSubject" ADD CONSTRAINT "GoalSubject_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalSubject" ADD CONSTRAINT "GoalSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoalMilestone" ADD CONSTRAINT "GoalMilestone_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Daily loop v2 (LOOP_V2_SPEC §1): the services validate these first; the database keeps them honest.
ALTER TABLE "User" ADD CONSTRAINT "User_dailyBudgetMin_range"
  CHECK ("dailyBudgetMin" BETWEEN 5 AND 120);
ALTER TABLE "User" ADD CONSTRAINT "User_nudgeTime_format"
  CHECK ("nudgeTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
