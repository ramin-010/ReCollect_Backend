-- SYNC_SPINE_SPEC 1.3: "About me, for my agents", a short profile every chat's brief starts with.
-- Additive.

ALTER TABLE "User" ADD COLUMN "agentProfile" VARCHAR(600);
