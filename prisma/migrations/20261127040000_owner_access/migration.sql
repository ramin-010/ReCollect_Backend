-- CreateEnum
CREATE TYPE "OwnerAccessKind" AS ENUM ('viewed', 'topped_up', 'limit_set', 'access_ended', 'access_restored');

-- CreateTable
CREATE TABLE "OwnerAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "OwnerAccessKind" NOT NULL,
    "details" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerAccess_userId_at_idx" ON "OwnerAccess"("userId", "at");

-- CreateIndex
CREATE INDEX "OwnerAccess_at_idx" ON "OwnerAccess"("at");

-- AddForeignKey
ALTER TABLE "OwnerAccess" ADD CONSTRAINT "OwnerAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

