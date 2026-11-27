// PERSONAL_OFFICE_PLAN §3 (11-23): every reader of sessions that judges, praises, nudges or shows consistency goes
// through the progress lens (src/services/learningDb/lens.ts), so work never counts for someone who didn't say so.
// This guard fails when a file reads WorkSession rows without the lens and is not on the list of readers that see
// both areas on purpose. A new reader: filter it with `sessionsOf` / `countedSessions` / `progressLens`, or add it
// here with the reason it must see work too.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../../src');

/** Readers that see both areas on purpose, and why. */
const BOTH_AREAS: Record<string, string> = {
    'services/learningDb/sessions.service.ts': 'the sessions themselves: writes, the list (a lens option), a folder’s own',
    'services/learningDb/lens.ts': 'the lens',
    'services/buddy/work.ts': 'the work log: time per folder beside its lines, work included',
    'services/users/accountExport.service.ts': 'the export: everything that is theirs',
    'services/users/accountSummary.service.ts': 'Your data: a count of everything kept, work included (TRUST_PLAN T3)',
    'services/agent/agentLifecycle.service.ts': 'one time entry by its id, corrected or removed on their word (TOOL_ACCESS_PLAN §12.4)',
    'services/learningDb/leetcode.service.ts': 'the import’s own de-duplication by key',
    'services/learningDb/subjectDeletion.service.ts': 'a subject’s delete and undo',
    'services/buddy/outcomes.ts': 'sessions named by id (an ask’s origin)',
    'controllers/learning/sessions.controller.ts': 'the session list as asked (GET /api/sessions)',
};

/** Signs a file reads sessions. */
const READS = /\b(?:prisma|db|tx)\.workSession\.(?:findMany|findFirst|findUnique|count|groupBy|aggregate)\b|\blistSessions\(|\bsessionDays\(/;
/** Signs it reads them through the lens. */
const LENS = /\b(?:sessionsOf|countedSessions|progressLens)\(/;

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? files(full) : name.endsWith('.ts') ? [full] : [];
    });
}

describe('the progress lens guard', () => {
    it('every reader of sessions filters by the lens, or sees both areas on purpose', () => {
        const offenders: string[] = [];
        for (const file of files(SRC)) {
            const rel = path.relative(SRC, file).replace(/\\/g, '/');
            const text = readFileSync(file, 'utf8');
            if (!READS.test(text) || BOTH_AREAS[rel] !== undefined) continue;
            if (!LENS.test(text)) offenders.push(rel);
        }
        expect(offenders).toEqual([]);
    });

    it('its list names files that still exist', () => {
        for (const rel of Object.keys(BOTH_AREAS)) expect(statSync(path.join(SRC, rel)).isFile()).toBe(true);
    });
});
