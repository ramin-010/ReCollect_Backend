-- Full-text search over docs (LOOP_COMPLETE_SPEC "Search on Postgres full-text").
--
-- "searchText": the doc's words, written by src/services/docs/docSearch.service.ts (NULL = not
-- written yet). "searchVector": the title (weight A) and the words (weight B), each both as English
-- stems ("caches" finds "cache") and as plain words (so the start of a word finds it), with a GIN
-- index. A trigger keeps it (not a generated column: Prisma reads a generated column's expression as
-- a default and would drop it in every later diff). Prisma sees a plain tsvector (Unsupported).

-- AlterTable
ALTER TABLE "Doc" ADD COLUMN "searchText" TEXT,
ADD COLUMN "searchVector" tsvector;

-- CreateIndex
CREATE INDEX "Doc_searchVector_idx" ON "Doc" USING GIN ("searchVector");

-- 1. A content change that doesn't bring its words sets them to NULL, so no save path can leave old
--    words behind: the next search, or the server's start, writes them again.
-- 2. The vector follows the title and the words.
CREATE FUNCTION "doc_search_fields"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW."yjsState" IS DISTINCT FROM OLD."yjsState"
       AND NEW."searchText" IS NOT DISTINCT FROM OLD."searchText" THEN
        NEW."searchText" := NULL;
    END IF;
    IF TG_OP = 'INSERT' OR NEW."title" IS DISTINCT FROM OLD."title"
       OR NEW."searchText" IS DISTINCT FROM OLD."searchText" THEN
        NEW."searchVector" :=
            setweight(to_tsvector('english'::regconfig, COALESCE(NEW."title", '')), 'A') ||
            setweight(to_tsvector('simple'::regconfig, COALESCE(NEW."title", '')), 'A') ||
            setweight(to_tsvector('english'::regconfig, COALESCE(NEW."searchText", '')), 'B') ||
            setweight(to_tsvector('simple'::regconfig, COALESCE(NEW."searchText", '')), 'B');
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "Doc_search_fields" BEFORE INSERT OR UPDATE OF "yjsState", "title", "searchText" ON "Doc"
    FOR EACH ROW EXECUTE FUNCTION "doc_search_fields"();

-- Docs already there: their titles now (the words come from the server's first pass).
UPDATE "Doc" SET "searchVector" =
    setweight(to_tsvector('english'::regconfig, COALESCE("title", '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, COALESCE("title", '')), 'A');
