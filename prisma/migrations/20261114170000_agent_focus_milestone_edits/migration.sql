-- BUDDY_PLAN slice A: agents can change or remove focus lines and remove milestones; each is
-- logged and undoable like their other learning writes. Additive: three new enum values.

-- AlterEnum
ALTER TYPE "AgentEditKind" ADD VALUE 'milestone_remove';
ALTER TYPE "AgentEditKind" ADD VALUE 'focus_update';
ALTER TYPE "AgentEditKind" ADD VALUE 'focus_remove';
