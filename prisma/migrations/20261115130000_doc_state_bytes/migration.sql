-- D3 (MANAGER_AND_DOCS_PLAN §1): a doc's Yjs state is stored as bytes, not as Base64 text.
--
-- Written by hand: Prisma's diff would drop the columns and add new ones, losing every doc. Postgres
-- decodes the Base64 in place instead (one rewrite of each table; nothing else changes, updatedAt
-- included). The search trigger names "yjsState" in its column list, which blocks a type change, so it
-- is dropped and made again around it; its function only compares the column (IS DISTINCT FROM), so it
-- works the same on bytes. A doc's words ("searchText") stay as they are: the content did not change.

DROP TRIGGER "Doc_search_fields" ON "Doc";

ALTER TABLE "Doc" ALTER COLUMN "yjsState" TYPE BYTEA USING decode("yjsState", 'base64');
ALTER TABLE "DocSnapshot" ALTER COLUMN "yjsState" TYPE BYTEA USING decode("yjsState", 'base64');
ALTER TABLE "DocSnapshot" ALTER COLUMN "agentUpdate" TYPE BYTEA USING decode("agentUpdate", 'base64');

CREATE TRIGGER "Doc_search_fields" BEFORE INSERT OR UPDATE OF "yjsState", "title", "searchText" ON "Doc"
    FOR EACH ROW EXECUTE FUNCTION "doc_search_fields"();
