-- DropForeignKey
ALTER TABLE "AccessRequest" DROP CONSTRAINT "AccessRequest_shareLinkId_fkey";

-- DropForeignKey
ALTER TABLE "DocBannedUser" DROP CONSTRAINT "DocBannedUser_docId_fkey";

-- DropForeignKey
ALTER TABLE "DocBannedUser" DROP CONSTRAINT "DocBannedUser_userId_fkey";

-- DropForeignKey
ALTER TABLE "ShareLink" DROP CONSTRAINT "ShareLink_docId_fkey";

-- DropForeignKey
ALTER TABLE "ShareLink" DROP CONSTRAINT "ShareLink_userId_fkey";

-- DropIndex
DROP INDEX "AccessRequest_shareLinkId_idx";

-- AlterTable
ALTER TABLE "AccessRequest" DROP COLUMN "shareLinkId",
ALTER COLUMN "role" SET DEFAULT 'editor';

-- AlterTable
ALTER TABLE "Doc" ADD COLUMN     "publicSlug" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- DropTable
DROP TABLE "DocBannedUser";

-- DropTable
DROP TABLE "ShareLink";

-- DropEnum
DROP TYPE "ShareLinkType";

-- CreateIndex
CREATE UNIQUE INDEX "Doc_publicSlug_key" ON "Doc"("publicSlug");

