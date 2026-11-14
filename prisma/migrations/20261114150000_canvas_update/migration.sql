-- update_canvas (AGENT_DIAGRAMS_PLAN step 2): an agent changes a canvas board in place; logged and
-- undoable like the other doc changes. Additive: one new enum value.

-- AlterEnum
ALTER TYPE "AgentEditKind" ADD VALUE 'doc_canvas_update';
