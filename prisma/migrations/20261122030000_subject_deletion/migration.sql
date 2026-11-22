-- CreateTable
CREATE TABLE "SubjectDeletion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "docIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubjectDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubjectDeletion_userId_createdAt_idx" ON "SubjectDeletion"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SubjectDeletion_expiresAt_idx" ON "SubjectDeletion"("expiresAt");

-- AddForeignKey
ALTER TABLE "SubjectDeletion" ADD CONSTRAINT "SubjectDeletion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

