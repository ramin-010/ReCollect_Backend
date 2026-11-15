-- SYNC_SPINE_SPEC 1.1: agents can rename a doc, file it under a subject, or make it the note of a
-- planned topic (update_doc). Logged and undoable like their other writes. Additive.

-- AlterEnum
ALTER TYPE "AgentEditKind" ADD VALUE 'doc_update';
