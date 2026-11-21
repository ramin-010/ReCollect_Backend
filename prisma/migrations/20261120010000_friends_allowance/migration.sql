-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN     "dailyCapUsd" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accessEndedAt" TIMESTAMP(3),
ADD COLUMN     "firstRun" JSONB;

-- CreateTable
CREATE TABLE "AiGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountUsd" DECIMAL(10,2) NOT NULL,
    "givenById" TEXT,
    "note" VARCHAR(200) NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignupInvite" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "name" VARCHAR(50) NOT NULL DEFAULT '',
    "code" VARCHAR(64) NOT NULL,
    "allowanceUsd" DECIMAL(10,2) NOT NULL DEFAULT 5,
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedById" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "SignupInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerSetting" (
    "key" VARCHAR(64) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'feedback',
    "text" VARCHAR(4000) NOT NULL DEFAULT '',
    "source" VARCHAR(10) NOT NULL DEFAULT 'web',
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiGrant_userId_createdAt_idx" ON "AiGrant"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SignupInvite_code_key" ON "SignupInvite"("code");

-- CreateIndex
CREATE INDEX "SignupInvite_email_idx" ON "SignupInvite"("email");

-- CreateIndex
CREATE INDEX "Feedback_userId_createdAt_idx" ON "Feedback"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_kind_createdAt_idx" ON "Feedback"("kind", "createdAt");

-- AddForeignKey
ALTER TABLE "AiGrant" ADD CONSTRAINT "AiGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGrant" ADD CONSTRAINT "AiGrant_givenById_fkey" FOREIGN KEY ("givenById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignupInvite" ADD CONSTRAINT "SignupInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignupInvite" ADD CONSTRAINT "SignupInvite_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

