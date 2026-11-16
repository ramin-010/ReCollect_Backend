// The office-data filter (hosting review A6: the Phase 2 seed; Phase 5's option). It runs on a disposable
// copy of a dev dump and deletes, for every account, what was captured from office work, with the
// records that depend on it:
//   - the office keys: the project keys office-flagged rows carry (WorkLine.office, BuddyChunk.office),
//     plus any key the operator names (a project captured before the flag existed);
//   - work lines and queued chat pieces that are office-flagged or carry an office key;
//   - notes (Observation) from an office project or an office session, and the memories citing them
//     or tagged with an office key;
//   - work sessions of an office project or an office session; the office projects themselves, with
//     their decisions and week targets (deleting a project only clears their link, so they go first).
// With clearDerived, the buddy's own writing is cleared too, for every account: the portrait and the
// notebook, the day lines and notes, the chapters, and the thumbs on them. No column marks office work
// in that text, so it cannot be filtered row by row.
//
// One transaction, rolled back for a dry run. Counts only; the statements are FILTER_STEPS, printed by
// `office-filter.js --print-sql`.

/** A pg Client (or anything with its query method). */
export interface Db {
    query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

/** The working sets, made inside the transaction; $1 = the keys the operator named. */
export const SETUP_SQL = [
    `CREATE TEMP TABLE office_keys (key text PRIMARY KEY) ON COMMIT DROP`,
    `INSERT INTO office_keys
       SELECT lower(project) FROM "WorkLine" WHERE office
       UNION SELECT lower(project) FROM "BuddyChunk" WHERE office AND project IS NOT NULL
       UNION SELECT lower(k) FROM unnest($1::text[]) AS k`,
    `CREATE TEMP TABLE office_sessions ON COMMIT DROP AS
       SELECT "sessionKey" AS key FROM "WorkLine" WHERE office OR lower(project) IN (SELECT key FROM office_keys)
       UNION SELECT "sessionKey" FROM "BuddyChunk" WHERE office OR lower(project) IN (SELECT key FROM office_keys)`,
    `CREATE TEMP TABLE office_observations ON COMMIT DROP AS
       SELECT id, "memoryId" FROM "Observation"
       WHERE lower(project) IN (SELECT key FROM office_keys) OR "sessionKey" IN (SELECT key FROM office_sessions)`,
    `CREATE TEMP TABLE office_projects ON COMMIT DROP AS
       SELECT id FROM "Project" WHERE lower(key) IN (SELECT key FROM office_keys)`,
];

export interface FilterStep {
    name: string;
    label: string;
    sql: string;
    /** Only with clearDerived. */
    derived?: boolean;
}

/** In this order: memories before their notes, sessions, decisions and week targets before their projects. */
export const FILTER_STEPS: FilterStep[] = [
    {
        name: 'memories',
        label: 'memories',
        sql: `DELETE FROM "Memory" WHERE id IN (SELECT "memoryId" FROM office_observations WHERE "memoryId" IS NOT NULL) OR tags && ARRAY(SELECT key FROM office_keys)`,
    },
    { name: 'observations', label: 'notes', sql: `DELETE FROM "Observation" WHERE id IN (SELECT id FROM office_observations)` },
    { name: 'workLines', label: 'work lines', sql: `DELETE FROM "WorkLine" WHERE office OR lower(project) IN (SELECT key FROM office_keys)` },
    { name: 'chunks', label: 'queued chat pieces', sql: `DELETE FROM "BuddyChunk" WHERE office OR lower(project) IN (SELECT key FROM office_keys)` },
    {
        name: 'sessions',
        label: 'work sessions',
        sql: `DELETE FROM "WorkSession" WHERE "projectId" IN (SELECT id FROM office_projects) OR key IN (SELECT key FROM office_sessions)`,
    },
    { name: 'decisions', label: 'decisions', sql: `DELETE FROM "Decision" WHERE "projectId" IN (SELECT id FROM office_projects)` },
    { name: 'weekTargets', label: 'week targets', sql: `DELETE FROM "WeekTarget" WHERE "projectId" IN (SELECT id FROM office_projects)` },
    { name: 'projects', label: 'projects', sql: `DELETE FROM "Project" WHERE id IN (SELECT id FROM office_projects)` },
    {
        name: 'portraits',
        label: 'portraits and notebooks cleared',
        derived: true,
        sql: `UPDATE "BuddyState" SET "who" = NULL, "heading" = NULL, "now" = NULL, "notebook" = NULL WHERE "who" IS NOT NULL OR "heading" IS NOT NULL OR "now" IS NOT NULL OR "notebook" IS NOT NULL`,
    },
    { name: 'buddyDays', label: 'buddy days (lines, notes, thoughts)', derived: true, sql: `DELETE FROM "BuddyDay"` },
    { name: 'buddyThumbs', label: 'thumbs on them', derived: true, sql: `DELETE FROM "BuddyFeedback"` },
    { name: 'chapters', label: 'chapters', derived: true, sql: `DELETE FROM "BuddyChapter"` },
];

/** Office rows left, by flag and by the given keys ($1): all zero after the filter, on the copy or on a restore of its dump. */
export const LEFT_SQL = `SELECT
  (SELECT count(*) FROM "WorkLine" WHERE office OR lower(project) = ANY($1::text[]))::int AS "workLines",
  (SELECT count(*) FROM "BuddyChunk" WHERE office OR lower(project) = ANY($1::text[]))::int AS "chunks",
  (SELECT count(*) FROM "Observation" WHERE lower(project) = ANY($1::text[]))::int AS "observations",
  (SELECT count(*) FROM "Memory" WHERE tags && $1::text[])::int AS "memories",
  (SELECT count(*) FROM "Project" WHERE lower(key) = ANY($1::text[]))::int AS "projects",
  (SELECT count(*) FROM "WorkSession" s JOIN "Project" p ON p.id = s."projectId" WHERE lower(p.key) = ANY($1::text[]))::int AS "sessions"`;

/** Where an office key is still named as a word ($1: a regular expression), counts only: for the owner to judge, never deleted. */
export const MENTIONS_SQL = `SELECT
  (SELECT count(*) FROM "Memory" WHERE text ~* $1)::int AS "memories",
  (SELECT count(*) FROM "Observation" WHERE text ~* $1)::int AS "notes",
  (SELECT count(*) FROM "WorkLine" WHERE text ~* $1)::int AS "work lines",
  (SELECT count(*) FROM "WorkSession" WHERE title ~* $1 OR "nextStep" ~* $1)::int AS "sessions",
  (SELECT count(*) FROM "Project" WHERE name ~* $1 OR "nextStep" ~* $1)::int AS "projects",
  (SELECT count(*) FROM "Decision" WHERE title ~* $1 OR why ~* $1 OR expect ~* $1 OR "verdictNote" ~* $1)::int AS "decisions",
  (SELECT count(*) FROM "WeekTarget" WHERE text ~* $1)::int AS "week targets",
  (SELECT count(*) FROM "Suggestion" WHERE text ~* $1)::int AS "suggestions",
  (SELECT count(*) FROM "FocusItem" WHERE text ~* $1)::int AS "focus lines",
  (SELECT count(*) FROM "Goal" WHERE title ~* $1)::int AS "goals",
  (SELECT count(*) FROM "GoalMilestone" WHERE title ~* $1)::int AS "milestones",
  (SELECT count(*) FROM "Todo" WHERE title ~* $1 OR description ~* $1)::int AS "tasks",
  (SELECT count(*) FROM "Capture" WHERE title ~* $1 OR content ~* $1)::int AS "captures",
  (SELECT count(*) FROM "QuickNote" WHERE content ~* $1)::int AS "quick notes",
  (SELECT count(*) FROM "Doc" WHERE title ~* $1 OR "searchText" ~* $1)::int AS "docs",
  (SELECT count(*) FROM "AssistantMessage" WHERE text ~* $1)::int AS "Ask AI messages",
  (SELECT count(*) FROM "BuddyDay" WHERE lines::text ~* $1 OR note ~* $1 OR insight ~* $1 OR "followUp" ~* $1)::int AS "buddy days",
  (SELECT count(*) FROM "BuddyChapter" WHERE text ~* $1)::int AS "chapters",
  (SELECT count(*) FROM "BuddyState" WHERE "who" ~* $1 OR "heading" ~* $1 OR "now" ~* $1 OR "notebook" ~* $1)::int AS "portraits",
  (SELECT count(*) FROM "BuddyChunk" WHERE messages::text ~* $1)::int AS "queued chat pieces"`;

/** Every project key the copy holds (folder names), so the operator can spot an office one the flags missed. */
const PROJECT_KEYS_SQL = `SELECT DISTINCT lower(k) AS key FROM (
  SELECT key AS k FROM "Project" UNION SELECT project FROM "WorkLine" UNION SELECT project FROM "Observation" WHERE project IS NOT NULL
  UNION SELECT project FROM "BuddyChunk" WHERE project IS NOT NULL) x ORDER BY 1`;

const ACCOUNTS_SQL = `SELECT count(DISTINCT u)::int AS n FROM (
  SELECT "userId" AS u FROM "WorkLine" WHERE office OR lower(project) IN (SELECT key FROM office_keys)
  UNION SELECT "userId" FROM "BuddyChunk" WHERE office OR lower(project) IN (SELECT key FROM office_keys)
  UNION SELECT "userId" FROM "Observation" WHERE id IN (SELECT id FROM office_observations)
  UNION SELECT "userId" FROM "Project" WHERE id IN (SELECT id FROM office_projects)) x`;

export interface FilterOptions {
    /** Keys to treat as office besides the flagged ones (case-insensitive). */
    officeKeys?: string[];
    clearDerived?: boolean;
}

export interface FilterResult {
    /** The office keys used: flagged in the data, plus the given ones. */
    keys: string[];
    /** Every project key in the copy. */
    projectKeys: string[];
    /** Accounts with office rows. */
    accounts: number;
    /** Rows each step deleted (or cleared), by step name. */
    counts: Record<string, number>;
    /** Office rows left after the steps (all zero). */
    left: Record<string, number>;
    /** Where an office key is still named as a word after the steps. */
    mentions: Record<string, number>;
    executed: boolean;
}

/** \m(erp|erp\-workspace)\M: the keys as whole words, any case. */
export function mentionPattern(keys: string[]): string | null {
    if (keys.length === 0) return null;
    return `\\m(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})\\M`;
}

const numbers = (row: Record<string, unknown> | undefined): Record<string, number> =>
    Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]));

/** Run the filter in one transaction: committed with execute, else rolled back (a dry run). */
export async function runOfficeFilter(db: Db, opts: FilterOptions, execute: boolean): Promise<FilterResult> {
    const given = [...new Set((opts.officeKeys ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean))];
    await db.query('BEGIN');
    try {
        for (const [i, sql] of SETUP_SQL.entries()) await db.query(sql, i === 1 ? [given] : undefined);
        const keys = (await db.query('SELECT key FROM office_keys ORDER BY key')).rows.map((r) => String(r.key));
        const projectKeys = (await db.query(PROJECT_KEYS_SQL)).rows.map((r) => String(r.key));
        const accounts = Number((await db.query(ACCOUNTS_SQL)).rows[0]?.n ?? 0);
        const counts: Record<string, number> = {};
        for (const step of FILTER_STEPS) {
            if (step.derived && !opts.clearDerived) continue;
            counts[step.name] = (await db.query(step.sql)).rowCount ?? 0;
        }
        const left = numbers((await db.query(LEFT_SQL, [keys])).rows[0]);
        const pattern = mentionPattern(keys);
        const mentions = pattern ? numbers((await db.query(MENTIONS_SQL, [pattern])).rows[0]) : {};
        await db.query(execute ? 'COMMIT' : 'ROLLBACK');
        return { keys, projectKeys, accounts, counts, left, mentions, executed: execute };
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
    }
}

/** Office rows left for these keys, read only: the re-count on the filtered copy or on a restore of its dump. */
export async function countOfficeRowsLeft(db: Db, keys: string[]): Promise<Record<string, number>> {
    return numbers((await db.query(LEFT_SQL, [keys.map((k) => k.toLowerCase())])).rows[0]);
}

/** Every statement, in order, for review (`--print-sql`). */
export function filterSqlText(clearDerived: boolean): string {
    const steps = FILTER_STEPS.filter((s) => clearDerived || !s.derived);
    return [
        '-- $1 = the office keys named with --office-key (text[]); the flagged ones are found in the data.',
        'BEGIN;',
        ...SETUP_SQL.map((s) => `${s};`),
        ...steps.map((s) => `-- ${s.label}\n${s.sql};`),
        '-- verify: every count is 0 ($1 = the office keys used)',
        `${LEFT_SQL};`,
        'COMMIT;',
    ].join('\n');
}
