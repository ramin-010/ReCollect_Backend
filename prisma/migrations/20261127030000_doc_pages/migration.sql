-- DOC_PAGES_PLAN (11-27): additions only, no backfill (every doc stays a top-level doc). A doc can hold docs (pages)
-- to any depth: its parent, its place among its parent's pages, and the doc whose trashing took it along. A note
-- remembers the page it was written on (its lesson stays its topic).

-- AlterTable
ALTER TABLE "Doc" ADD COLUMN     "parentId" TEXT,
ADD COLUMN     "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "trashedWithId" TEXT;

-- AlterTable
ALTER TABLE "Capture" ADD COLUMN     "docId" TEXT;

-- CreateIndex
CREATE INDEX "Doc_parentId_position_idx" ON "Doc"("parentId", "position");

-- CreateIndex
CREATE INDEX "Capture_docId_idx" ON "Capture"("docId");

-- AddForeignKey
ALTER TABLE "Doc" ADD CONSTRAINT "Doc_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Doc"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Capture" ADD CONSTRAINT "Capture_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE SET NULL ON UPDATE CASCADE;
