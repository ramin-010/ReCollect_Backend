-- AlterTable
ALTER TABLE "FocusItem" ADD COLUMN     "doneAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "leetcodeSyncedAt" TIMESTAMP(3),
ADD COLUMN     "leetcodeUser" VARCHAR(40);
