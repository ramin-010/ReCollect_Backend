-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('fact', 'preference', 'value', 'aim', 'idea', 'decision', 'pattern', 'state', 'thread', 'win');

-- CreateEnum
CREATE TYPE "Sensitivity" AS ENUM ('open', 'private');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('active', 'faded', 'closed', 'wrong');

-- CreateEnum
CREATE TYPE "BuddySource" AS ENUM ('hook', 'agent', 'app', 'tell', 'feedback', 'buddy');

-- AlterEnum
ALTER TYPE "AgentEditKind" ADD VALUE 'memory_close';

-- CreateTable
CREATE TABLE "BuddyState" (
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "name" VARCHAR(40),
    "tone" VARCHAR(20) NOT NULL DEFAULT 'candid',
    "who" TEXT,
    "heading" TEXT,
    "now" TEXT,
    "notebook" TEXT,
    "capUsd" DECIMAL(10,2) NOT NULL DEFAULT 25,
    "lastNightDay" DATE,
    "lastStepAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuddyState_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" VARCHAR(300) NOT NULL,
    "kind" "MemoryKind" NOT NULL,
    "sensitivity" "Sensitivity" NOT NULL DEFAULT 'open',
    "source" "BuddySource" NOT NULL,
    "agentName" VARCHAR(60),
    "sessionKey" VARCHAR(80),
    "project" VARCHAR(100),
    "day" DATE NOT NULL,
    "memoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" VARCHAR(300) NOT NULL,
    "kind" "MemoryKind" NOT NULL,
    "sensitivity" "Sensitivity" NOT NULL DEFAULT 'open',
    "status" "MemoryStatus" NOT NULL DEFAULT 'active',
    "lasting" BOOLEAN NOT NULL DEFAULT true,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "byUser" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "BuddySource" NOT NULL,
    "agentName" VARCHAR(60),
    "decisionId" TEXT,
    "seenCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenDay" DATE NOT NULL,
    "lastSeenDay" DATE NOT NULL,
    "monthsSeen" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "closedDay" DATE,
    "closeReason" VARCHAR(200),
    "supersedesId" TEXT,
    "searchVector" tsvector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Observation_userId_day_idx" ON "Observation"("userId", "day");

-- CreateIndex
CREATE INDEX "Observation_memoryId_idx" ON "Observation"("memoryId");

-- CreateIndex
CREATE INDEX "Memory_userId_status_kind_idx" ON "Memory"("userId", "status", "kind");

-- CreateIndex
CREATE INDEX "Memory_searchVector_idx" ON "Memory" USING GIN ("searchVector");

-- AddForeignKey
ALTER TABLE "BuddyState" ADD CONSTRAINT "BuddyState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "Memory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The memory's words for full-text search (as the docs' search, migration 20261114250000_doc_search):
-- English stems and plain words, kept by a trigger (not a generated column: Prisma would drop it in
-- a later diff). Prisma sees a plain tsvector (Unsupported).
CREATE FUNCTION "memory_search_fields"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW."text" IS DISTINCT FROM OLD."text" THEN
        NEW."searchVector" :=
            to_tsvector('english'::regconfig, COALESCE(NEW."text", '')) ||
            to_tsvector('simple'::regconfig, COALESCE(NEW."text", ''));
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Memory_search_fields" BEFORE INSERT OR UPDATE OF "text" ON "Memory"
    FOR EACH ROW EXECUTE FUNCTION "memory_search_fields"();
