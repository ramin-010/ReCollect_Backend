-- AlterEnum
ALTER TYPE "AiFeature" ADD VALUE 'doc_ask';

-- AlterTable
ALTER TABLE "AssistantThread" ADD COLUMN     "docId" TEXT;

-- CreateIndex
CREATE INDEX "AssistantThread_docId_idx" ON "AssistantThread"("docId");

-- AddForeignKey
ALTER TABLE "AssistantThread" ADD CONSTRAINT "AssistantThread_docId_fkey" FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

