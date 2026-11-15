-- CreateTable
CREATE TABLE "ImportedRow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "sourceTable" VARCHAR(60) NOT NULL,
    "sourceId" VARCHAR(80) NOT NULL,
    "targetTable" VARCHAR(60) NOT NULL,
    "targetId" VARCHAR(80) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportedRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImportedRow_userId_source_sourceTable_sourceId_key" ON "ImportedRow"("userId", "source", "sourceTable", "sourceId");

-- AddForeignKey
ALTER TABLE "ImportedRow" ADD CONSTRAINT "ImportedRow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

