-- CreateEnum
CREATE TYPE "WorkLineKind" AS ENUM ('did', 'decided', 'stuck', 'next');

-- AlterEnum
ALTER TYPE "AiFeature" ADD VALUE 'buddy_work';

-- AlterTable
ALTER TABLE "BuddyCaptureDay" ADD COLUMN     "work" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BuddyChunk" ADD COLUMN     "office" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "BuddyState" ADD COLUMN     "workLog" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "WorkLine" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "project" VARCHAR(100) NOT NULL,
    "sessionKey" VARCHAR(80) NOT NULL,
    "kind" "WorkLineKind" NOT NULL,
    "text" VARCHAR(200) NOT NULL,
    "office" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "searchVector" tsvector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkLine_userId_day_idx" ON "WorkLine"("userId", "day");

-- CreateIndex
CREATE INDEX "WorkLine_userId_project_day_idx" ON "WorkLine"("userId", "project", "day");

-- CreateIndex
CREATE INDEX "WorkLine_userId_sessionKey_day_idx" ON "WorkLine"("userId", "sessionKey", "day");

-- CreateIndex
CREATE INDEX "WorkLine_searchVector_idx" ON "WorkLine" USING GIN ("searchVector");

-- AddForeignKey
ALTER TABLE "WorkLine" ADD CONSTRAINT "WorkLine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The work lines' words for full-text search (as the memories'): English stems and plain words, kept
-- by a trigger (not a generated column: Prisma would drop it in a later diff).
CREATE FUNCTION "work_line_search_fields"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW."text" IS DISTINCT FROM OLD."text" THEN
        NEW."searchVector" :=
            to_tsvector('english'::regconfig, COALESCE(NEW."text", '')) ||
            to_tsvector('simple'::regconfig, COALESCE(NEW."text", ''));
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "WorkLine_search_fields" BEFORE INSERT OR UPDATE OF "text" ON "WorkLine"
    FOR EACH ROW EXECUTE FUNCTION "work_line_search_fields"();
