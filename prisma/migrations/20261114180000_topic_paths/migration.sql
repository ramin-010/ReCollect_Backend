-- BUDDY_PLAN B1: subjects get a path. A topic has a status (existing topics were learned: done),
-- when it was started and finished, and the next step an agent left on it. Additive.

CREATE TYPE "TopicStatus" AS ENUM ('planned', 'in_progress', 'done', 'skipped');

ALTER TABLE "Topic" ADD COLUMN "status" "TopicStatus" NOT NULL DEFAULT 'done',
    ADD COLUMN "startedAt" TIMESTAMP(3),
    ADD COLUMN "doneAt" TIMESTAMP(3),
    ADD COLUMN "nextStep" VARCHAR(300);

ALTER TYPE "AgentEditKind" ADD VALUE 'path_plan';
ALTER TYPE "AgentEditKind" ADD VALUE 'topic_update';
