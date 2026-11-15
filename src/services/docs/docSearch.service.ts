// Search over docs on Postgres full-text (LOOP_COMPLETE_SPEC "Search on Postgres full-text"):
// GET /api/agent/docs?query= (the MCP tool search_docs) and GET /api/docs/search?q= (the library).
//
// Doc.searchText holds a doc's words: each textblock on its own line, and the words on its canvas
// boards (docPlainText). Doc.searchVector weighs the title (A) over the words (B), each as English
// stems and as plain words, with a GIN index; a trigger keeps it (migration 20261114250000_doc_search).
// The words are written only here. A save that changes the content without them sets them to NULL
// (the same trigger), each search first writes the words of the searcher's docs that have none
// (the few edited since the last search), and the server's start writes the rest (the migration,
// an import). So no save path has to remember them, and none can leave old words behind.
//
// A query matches when each of its words does, in some form: its English stem ("caches" finds
// "cache") or the start of a word ("lim" finds "limiter"). The whole query inside a title matches
// too (for what words drop: "C++", "O(n)"). Order: a title holding the query, then ts_rank (title
// words weigh most), then newest. The snippet is ts_headline's, with the matched words marked.
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { JSONContent } from '@tiptap/core';
import { prisma } from '../../db/prisma';
import { canvasTexts } from './canvas';
import { yjsStateToDocJson } from './docContent';
import type { DocState } from './docState';
import { nodePlainText } from './markdown/docMarkdown';

export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_QUERY_MAX = 200;
const MAX_TERMS = 8;
const TERM_MAX = 64;
/** Docs whose words one search writes at most (any left wait for the next search). */
const REFRESH_PER_SEARCH = 200;
const REFRESH_BATCH = 50;
export const SNIPPET_MAX = 160;
/** Characters kept before the first match, at most (so the match shows near the start). */
const SNIPPET_LEAD = 60;
const MARK_START = '\u0002';
const MARK_STOP = '\u0003';
const HEADLINE_OPTIONS = `StartSel=${MARK_START}, StopSel=${MARK_STOP}, MaxWords=35, MinWords=15, ShortWord=0, MaxFragments=1`;

// ─── A doc's words ─────────────────────────────────────────────────────

/** Each textblock of a doc on its own line (and the words on a canvas board, when injected). */
export function docPlainText(doc: JSONContent): string {
    const lines: string[] = [];
    const walk = (node: JSONContent | undefined) => {
        if (!node || typeof node !== 'object') return;
        const content = Array.isArray(node.content) ? node.content : [];
        if (content.some((child) => child.type === 'text' || child.type === 'hardBreak')) {
            lines.push(nodePlainText(node));
            return;
        }
        if (node.type === 'embed' && node.attrs?.['url']) lines.push(String(node.attrs['url']));
        if (node.type === 'canvas') lines.push(...canvasTexts(node.attrs?.['data']));
        content.forEach(walk);
    };
    walk(doc);
    return lines.filter((line) => line.trim()).join('\n');
}

/** The words of a stored doc: '' for an empty or unreadable state. */
export function searchTextOf(yjsState: DocState | null): string {
    if (!yjsState) return '';
    try {
        return docPlainText(yjsStateToDocJson(yjsState) as JSONContent);
    } catch {
        return '';
    }
}

/** Doc rows (alias d) the user may open: docPermissions.accessibleDocWhere in SQL. */
function accessibleSql(userId: string): Prisma.Sql {
    return Prisma.sql`(d."userId" = ${userId} OR
        EXISTS (SELECT 1 FROM "DocCollaborator" c WHERE c."docId" = d."id" AND c."userId" = ${userId}))`;
}

/** The md5 of a stored state's bytes, as Postgres's md5(bytea) gives it. */
const md5 = (state: Uint8Array): string => createHash('md5').update(state).digest('hex');

/**
 * Write the words of docs that have none (searchText NULL): the docs `userId` may open (not
 * archived), or every doc. At most `max` docs are tried, newest first. A doc whose content changed between the read
 * and the write is left for the next pass (its words would be old). Raw SQL, so updatedAt stays.
 * Returns how many docs got their words.
 */
export async function refreshSearchText(scope: { userId?: string } = {}, max: number = REFRESH_PER_SEARCH): Promise<number> {
    let written = 0;
    let tried = 0;
    const skipped: string[] = [];
    while (tried < max) {
        const rows = await prisma.$queryRaw<Array<{ id: string; yjsState: Uint8Array | null }>>`
            SELECT d."id", d."yjsState" FROM "Doc" d
            WHERE d."searchText" IS NULL
            ${scope.userId ? Prisma.sql`AND NOT d."isArchived" AND ${accessibleSql(scope.userId)}` : Prisma.empty}
            ${skipped.length > 0 ? Prisma.sql`AND d."id" <> ALL(${skipped}::text[])` : Prisma.empty}
            ORDER BY d."updatedAt" DESC
            LIMIT ${Math.min(REFRESH_BATCH, max - tried)}`;
        if (rows.length === 0) break;
        for (const row of rows) {
            tried += 1;
            const changed = await prisma.$executeRaw`
                UPDATE "Doc" SET "searchText" = ${searchTextOf(row.yjsState)}
                WHERE "id" = ${row.id} AND "searchText" IS NULL AND md5(COALESCE("yjsState", ''::bytea)) = ${md5(row.yjsState ?? new Uint8Array())}`;
            if (changed > 0) written += 1;
            else skipped.push(row.id);
        }
    }
    return written;
}

/** At the server's start: the words of every doc that has none (after the migration, an import). */
export function startSearchTextPass(): void {
    refreshSearchText({}, Number.POSITIVE_INFINITY)
        .then((count) => {
            if (count > 0) console.log(`[search] wrote the words of ${count} doc(s)`);
        })
        .catch((err) => console.error('[search] could not write the words of docs:', err));
}

// ─── Search ────────────────────────────────────────────────────────────

export interface DocSearchHit {
    id: string;
    title: string;
    updatedAt: Date;
    /** The doc's block with the first match (its first block without one); '' for an empty doc. */
    snippet: string;
    /** [start, end) of each matched word in `snippet`. */
    marks: Array<[number, number]>;
}

/** The words of a query: letters and digits, lower case, each once, at most 8. */
export function searchTerms(query: string): string[] {
    const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return [...new Set(words.map((w) => w.slice(0, TERM_MAX)))].slice(0, MAX_TERMS);
}

/** ILIKE pattern: the text anywhere (its %, _ and \ taken literally). */
function containsPattern(text: string): string {
    return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

interface SnippetLine {
    text: string;
    marks: Array<[number, number]>;
}

/** A headline's lines (a doc's blocks), each with its whitespace collapsed and its marks as offsets. */
function headlineLines(headline: string): SnippetLine[] {
    const lines: SnippetLine[] = [];
    let line: SnippetLine = { text: '', marks: [] };
    let open = -1;
    let space = false;
    const closeMark = () => {
        if (open >= 0 && line.text.length > open) line.marks.push([open, line.text.length]);
        open = -1;
    };
    for (const ch of headline) {
        if (ch === '\n') {
            closeMark();
            if (line.text) lines.push(line);
            line = { text: '', marks: [] };
            space = false;
        } else if (ch === MARK_START) {
            if (space && line.text) line.text += ' ';
            space = false;
            open = line.text.length;
        } else if (ch === MARK_STOP) {
            closeMark();
        } else if (/\s/u.test(ch)) {
            space = true;
        } else {
            if (space && line.text) line.text += ' ';
            space = false;
            line.text += ch;
        }
    }
    closeMark();
    if (line.text) lines.push(line);
    return lines;
}

const sameText = (text: string): string => text.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim();
const BLOCK_JOIN = ' · ';

/** The line cut at a word boundary to at most `max` characters, '…' added; its marks clipped. */
function cutTail(line: SnippetLine, max: number): SnippetLine {
    if (line.text.length <= max) return line;
    const lastSpace = line.text.lastIndexOf(' ', max);
    const end = lastSpace > max / 2 ? lastSpace : max;
    return { text: `${line.text.slice(0, end)}…`, marks: line.marks.filter(([a]) => a < end).map(([a, b]) => [a, Math.min(b, end)]) };
}

/**
 * ts_headline's text as a snippet: the first block (line) with a match, else the first block (a
 * block that only repeats the title doesn't count), then the blocks after it while they fit, joined
 * by " · " (headings, list items and canvas words are short). The marks become offsets; the lead is
 * cut so the first match shows; at most SNIPPET_MAX characters, '…' where cut.
 */
export function snippetFrom(headline: string, title = ''): { snippet: string; marks: Array<[number, number]> } {
    const titleText = sameText(title);
    const lines = headlineLines(headline).filter((l) => !titleText || sameText(l.text) !== titleText);
    const at = Math.max(0, lines.findIndex((l) => l.marks.length > 0));
    const chosen = lines[at];
    if (!chosen) return { snippet: '', marks: [] };
    let { text, marks } = chosen;
    const first = marks[0];
    if (first && first[0] > SNIPPET_LEAD) {
        const cut = text.indexOf(' ', first[0] - SNIPPET_LEAD);
        if (cut >= 0 && cut < first[0]) {
            text = `…${text.slice(cut + 1)}`;
            marks = marks.map(([a, b]) => [a - cut, b - cut]);
        }
    }
    ({ text, marks } = cutTail({ text, marks }, SNIPPET_MAX));
    for (const next of lines.slice(at + 1)) {
        const room = SNIPPET_MAX - text.length - BLOCK_JOIN.length;
        if (room < 24 || text.endsWith('…')) break;
        const piece = cutTail(next, room);
        const offset = text.length + BLOCK_JOIN.length;
        text += BLOCK_JOIN + piece.text;
        marks = [...marks, ...piece.marks.map(([a, b]): [number, number] => [a + offset, b + offset])];
    }
    return { snippet: text, marks };
}

const clampLimit = (limit: number | undefined): number => Math.min(Math.max(Math.trunc(limit ?? SEARCH_LIMIT_DEFAULT), 1), SEARCH_LIMIT_MAX);

/**
 * The docs `userId` may open (own and shared with them; not archived, not in the trash) that match `query`, best
 * first, each with a snippet. No query: the most recently updated docs, each with its start.
 */
export async function searchDocs(userId: string, options: { query?: string | undefined; limit?: number | undefined }): Promise<DocSearchHit[]> {
    const limit = clampLimit(options.limit);
    const raw = (options.query ?? '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_QUERY_MAX);
    await refreshSearchText({ userId });

    if (!raw) {
        const rows = await prisma.$queryRaw<Array<{ id: string; title: string; updatedAt: Date; text: string | null }>>`
            SELECT d."id", d."title", d."updatedAt", left(d."searchText", 600) AS "text"
            FROM "Doc" d
            WHERE NOT d."isArchived" AND d."trashedAt" IS NULL AND ${accessibleSql(userId)}
            ORDER BY d."updatedAt" DESC, d."id" DESC
            LIMIT ${limit}`;
        return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, ...snippetFrom(r.text ?? '', r.title) }));
    }

    const terms = searchTerms(raw);
    const tsQuery =
        terms.length > 0
            ? Prisma.join(
                  terms.map((t) => Prisma.sql`(to_tsquery('english', ${t}) || to_tsquery('simple', ${`${t}:*`}))`),
                  ' && '
              )
            : Prisma.sql`NULL::tsquery`;
    const inTitle = containsPattern(raw);
    const rows = await prisma.$queryRaw<Array<{ id: string; title: string; updatedAt: Date; headline: string | null }>>`
        WITH q AS (SELECT ${tsQuery} AS "query"),
        hits AS (
            SELECT d."id", d."title", d."updatedAt", d."searchText",
                   (CASE WHEN d."title" ILIKE ${inTitle} THEN 1 ELSE 0 END) + COALESCE(ts_rank(d."searchVector", q."query"), 0) AS "rank"
            FROM "Doc" d, q
            WHERE NOT d."isArchived" AND d."trashedAt" IS NULL AND ${accessibleSql(userId)}
              AND (d."searchVector" @@ q."query" OR d."title" ILIKE ${inTitle})
            ORDER BY "rank" DESC, d."updatedAt" DESC, d."id" DESC
            LIMIT ${limit}
        )
        SELECT h."id", h."title", h."updatedAt",
               CASE
                   WHEN q."query" IS NULL OR COALESCE(h."searchText", '') = '' THEN left(COALESCE(h."searchText", ''), 600)
                   ELSE (SELECT CASE WHEN strpos(e."text", ${MARK_START}) > 0 THEN e."text"
                                     ELSE ts_headline('simple', h."searchText", q."query", ${HEADLINE_OPTIONS}) END
                         FROM (SELECT ts_headline('english', h."searchText", q."query", ${HEADLINE_OPTIONS}) AS "text") e)
               END AS "headline"
        FROM hits h, q
        ORDER BY h."rank" DESC, h."updatedAt" DESC, h."id" DESC`;
    return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, ...snippetFrom(r.headline ?? '', r.title) }));
}
