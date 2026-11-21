-- AlterTable
ALTER TABLE "AssistantMessage" ADD COLUMN     "buddyReadAt" TIMESTAMP(3),
ADD COLUMN     "buddySkip" BOOLEAN NOT NULL DEFAULT false;


-- AlterTable
ALTER TABLE "AssistantThread" ADD COLUMN     "askId" VARCHAR(30);


-- AlterTable
ALTER TABLE "BuddyChunk" ADD COLUMN     "saidFrom" TIMESTAMP(3),
ADD COLUMN     "via" VARCHAR(20);


-- AlterTable
ALTER TABLE "BuddyDay" ADD COLUMN     "insightAbout" JSONB,
ADD COLUMN     "noteAbout" JSONB;


-- AlterTable
ALTER TABLE "BuddyState" ADD COLUMN     "loop" BOOLEAN NOT NULL DEFAULT false;


-- AlterTable
ALTER TABLE "Observation" ADD COLUMN     "saidAt" TIMESTAMP(3),
ADD COLUMN     "via" VARCHAR(20);


-- CreateTable
CREATE TABLE "BuddyThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stage" VARCHAR(20) NOT NULL DEFAULT 'noticed',
    "lookAgainOn" DATE,
    "rhythm" VARCHAR(10) NOT NULL DEFAULT 'none',
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "onScreens" BOOLEAN NOT NULL DEFAULT true,
    "steer" VARCHAR(200),
    "noAsk" BOOLEAN NOT NULL DEFAULT false,
    "quietUntil" TIMESTAMP(3),
    "goalId" TEXT,
    "taskId" TEXT,
    "memoryId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lastSaidAt" TIMESTAMP(3) NOT NULL,
    "firstDay" DATE NOT NULL,
    "closedAt" TIMESTAMP(3),
    "searchVector" tsvector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuddyThread_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "BuddyThreadEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "text" VARCHAR(200) NOT NULL,
    "saidAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "forDay" DATE NOT NULL,
    "direct" BOOLEAN NOT NULL DEFAULT true,
    "duplicate" BOOLEAN NOT NULL DEFAULT false,
    "via" VARCHAR(20) NOT NULL,
    "observationId" TEXT,
    "askId" TEXT,
    "originKey" VARCHAR(160) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuddyThreadEvent_pkey" PRIMARY KEY ("id")
);


-- CreateTable
CREATE TABLE "BuddyAsk" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT,
    "kind" VARCHAR(10) NOT NULL DEFAULT 'ask',
    "text" VARCHAR(200) NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "seenRevision" INTEGER,
    "buddyDayId" TEXT,
    "fromAt" TIMESTAMP(3) NOT NULL,
    "untilAt" TIMESTAMP(3) NOT NULL,
    "state" VARCHAR(12) NOT NULL DEFAULT 'open',
    "shownOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstShownAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "answer" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuddyAsk_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE INDEX "BuddyThread_userId_stage_idx" ON "BuddyThread"("userId", "stage");


-- CreateIndex
CREATE INDEX "BuddyThread_searchVector_idx" ON "BuddyThread" USING GIN ("searchVector");


-- CreateIndex
CREATE INDEX "BuddyThreadEvent_threadId_saidAt_idx" ON "BuddyThreadEvent"("threadId", "saidAt");


-- CreateIndex
CREATE UNIQUE INDEX "BuddyThreadEvent_userId_originKey_key" ON "BuddyThreadEvent"("userId", "originKey");


-- CreateIndex
CREATE INDEX "BuddyAsk_userId_state_untilAt_idx" ON "BuddyAsk"("userId", "state", "untilAt");


-- AddForeignKey
ALTER TABLE "BuddyThread" ADD CONSTRAINT "BuddyThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "BuddyThreadEvent" ADD CONSTRAINT "BuddyThreadEvent_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "BuddyThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "BuddyAsk" ADD CONSTRAINT "BuddyAsk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AddForeignKey
ALTER TABLE "BuddyAsk" ADD CONSTRAINT "BuddyAsk_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "BuddyThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The thread's words for full-text search (as the memory's, migration 20261116010000_buddy_memory):
-- its title and keywords, English stems and plain words, kept by a trigger. Prisma sees a plain tsvector.
CREATE FUNCTION "buddy_thread_search_fields"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW."title" IS DISTINCT FROM OLD."title" OR NEW."keywords" IS DISTINCT FROM OLD."keywords" THEN
        NEW."searchVector" :=
            to_tsvector('english'::regconfig, COALESCE(NEW."title", '') || ' ' || array_to_string(NEW."keywords", ' ')) ||
            to_tsvector('simple'::regconfig, COALESCE(NEW."title", '') || ' ' || array_to_string(NEW."keywords", ' '));
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "BuddyThread_search_fields" BEFORE INSERT OR UPDATE OF "title", "keywords" ON "BuddyThread"
    FOR EACH ROW EXECUTE FUNCTION "buddy_thread_search_fields"();
