-- CreateTable
CREATE TABLE "StandTake" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "window" VARCHAR(8) NOT NULL,
    "text" VARCHAR(1200) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandTake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StandTake_userId_day_window_key" ON "StandTake"("userId", "day", "window");

-- AddForeignKey
ALTER TABLE "StandTake" ADD CONSTRAINT "StandTake_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
