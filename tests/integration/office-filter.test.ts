// The office-data filter (hosting review A6; scripts/lib/officeFilter.ts) on the test database, two
// accounts: office rows and what depends on them go for every account; personal rows stay; a dry run
// changes nothing; a key the flags missed is caught when named; the buddy's own writing is cleared
// only when asked; the re-count is zero.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { getTestDatabaseUrl, truncateAllTables } from '../helpers/testDb';
import { countOfficeRowsLeft, runOfficeFilter } from '../../scripts/lib/officeFilter';

const DAY = new Date('2026-11-16');
let db: Client;

beforeEach(async () => {
    await truncateAllTables(getTestDatabaseUrl());
    db = new Client({ connectionString: getTestDatabaseUrl() });
    await db.connect();
});
afterEach(async () => {
    await db.end();
});

const work = (userId: string, project: string, sessionKey: string, office: boolean, text: string) =>
    prisma.workLine.create({ data: { userId, day: DAY, project, sessionKey, kind: 'did', text, office } });
const note = (userId: string, project: string | null, sessionKey: string | null, memoryId: string | null, text: string) =>
    prisma.observation.create({ data: { userId, text, kind: 'fact', source: 'hook', day: DAY, project, sessionKey, memoryId } });
const memory = (userId: string, text: string, tags: string[] = []) =>
    prisma.memory.create({ data: { userId, text, kind: 'fact', source: 'hook', firstSeenDay: DAY, lastSeenDay: DAY, tags } });

async function seed() {
    const owner = await createTestUser();
    const other = await createTestUser();
    const erp = await prisma.project.create({ data: { userId: owner.id, key: 'erp', name: 'ERP' } });
    const mine = await prisma.project.create({ data: { userId: owner.id, key: 'second_brain', name: 'Recollect' } });
    await prisma.project.create({ data: { userId: owner.id, key: 'legacy-client', name: 'Before the flag' } });
    await prisma.project.create({ data: { userId: other.id, key: 'erp', name: 'ERP' } });
    for (const p of [erp, mine]) {
        await prisma.workSession.create({ data: { userId: owner.id, day: DAY, startedAt: DAY, title: `a session in ${p.key}`, kind: 'build', projectId: p.id, key: `cc_${p.key}` } });
        await prisma.decision.create({ data: { userId: owner.id, title: `a decision in ${p.key}`, why: 'because', lookAgainDay: DAY, projectId: p.id } });
        await prisma.weekTarget.create({ data: { userId: owner.id, weekStart: DAY, text: `a target in ${p.key}`, projectId: p.id } });
    }
    // an office session known only by its key (no project): its pieces were flagged
    await prisma.workSession.create({ data: { userId: owner.id, day: DAY, startedAt: DAY, title: 'office chat', kind: 'build', key: 'cc_office2' } });
    await work(owner.id, 'erp', 'cc_office1', true, 'office line one');
    await work(owner.id, 'erp', 'cc_office1', true, 'office line two');
    await work(owner.id, 'second_brain', 'cc_mine', false, 'personal line');
    await work(other.id, 'erp', 'cc_other', true, "the other account's office line");
    await prisma.buddyChunk.create({ data: { userId: owner.id, sessionKey: 'cc_office2', seq: 1, project: 'erp-workspace', office: true, messages: [] } });
    await prisma.buddyChunk.create({ data: { userId: owner.id, sessionKey: 'cc_mine', seq: 1, project: 'second_brain', messages: [] } });
    const cited = await memory(owner.id, 'a memory from an office note');
    const kept = await memory(owner.id, 'a memory from a personal note');
    await memory(owner.id, 'tagged with the office project', ['erp']);
    await memory(owner.id, 'tagged with a personal project', ['second_brain']);
    await note(owner.id, 'erp', 'cc_office1', cited.id, 'an office note');
    await note(owner.id, 'second_brain', 'cc_mine', kept.id, 'a personal note');
    await note(owner.id, null, 'cc_office2', null, 'a note from the office session');
    await note(owner.id, 'legacy-client', 'cc_legacy', null, 'a note from before the flag');
    await prisma.buddyState.create({ data: { userId: owner.id, enabled: true, who: 'portrait', heading: 'heading', now: 'now', notebook: 'notebook' } });
    const day = await prisma.buddyDay.create({ data: { userId: owner.id, day: DAY, kind: 'night', lines: [], model: 'm' } });
    await prisma.buddyFeedback.create({ data: { userId: owner.id, buddyDayId: day.id, target: 'note', verdict: 'more' } });
    await prisma.buddyChapter.create({ data: { userId: owner.id, period: '2026-10', text: 'a chapter', model: 'm' } });
    return { owner, other };
}

async function snapshot() {
    return {
        workLines: await prisma.workLine.count(),
        chunks: await prisma.buddyChunk.count(),
        observations: await prisma.observation.count(),
        memories: await prisma.memory.count(),
        sessions: await prisma.workSession.count(),
        decisions: await prisma.decision.count(),
        weekTargets: await prisma.weekTarget.count(),
        projects: await prisma.project.count(),
        buddyDays: await prisma.buddyDay.count(),
        chapters: await prisma.buddyChapter.count(),
        thumbs: await prisma.buddyFeedback.count(),
    };
}

describe('the office-data filter', () => {
    it('a dry run reports for every account and changes nothing', async () => {
        await seed();
        const before = await snapshot();
        const r = await runOfficeFilter(db, {}, false);
        expect(r.keys).toEqual(['erp', 'erp-workspace']);
        expect(r.accounts).toBe(2);
        expect(r.counts).toEqual({ memories: 2, observations: 2, workLines: 3, chunks: 1, sessions: 2, decisions: 1, weekTargets: 1, projects: 2 });
        expect(Object.values(r.left).every((n) => n === 0)).toBe(true);
        expect(r.projectKeys).toEqual(expect.arrayContaining(['erp', 'erp-workspace', 'legacy-client', 'second_brain']));
        expect(await snapshot()).toEqual(before);
    });

    it('applied: office rows and their dependents go for every account, personal rows and the buddy\'s writing stay', async () => {
        await seed();
        const r = await runOfficeFilter(db, {}, true);
        expect(r.executed).toBe(true);
        expect(await snapshot()).toEqual({ workLines: 1, chunks: 1, observations: 2, memories: 2, sessions: 1, decisions: 1, weekTargets: 1, projects: 2, buddyDays: 1, chapters: 1, thumbs: 1 });
        expect((await prisma.workLine.findMany({ select: { text: true } })).map((w) => w.text)).toEqual(['personal line']);
        expect((await prisma.memory.findMany({ select: { text: true }, orderBy: { text: 'asc' } })).map((m) => m.text)).toEqual(['a memory from a personal note', 'tagged with a personal project']);
        expect((await prisma.project.findMany({ select: { key: true }, orderBy: { key: 'asc' } })).map((p) => p.key)).toEqual(['legacy-client', 'second_brain']);
        expect((await prisma.workSession.findMany({ select: { title: true } })).map((s) => s.title)).toEqual(['a session in second_brain']);
        expect(await countOfficeRowsLeft(db, r.keys)).toEqual({ workLines: 0, chunks: 0, observations: 0, memories: 0, projects: 0, sessions: 0 });
        expect((await prisma.buddyState.findFirstOrThrow()).who).toBe('portrait');
    });

    it('a key the flags missed is caught when named; --clear-derived clears the buddy\'s own writing', async () => {
        const { owner } = await seed();
        const r = await runOfficeFilter(db, { officeKeys: ['Legacy-Client'], clearDerived: true }, true);
        expect(r.keys).toEqual(['erp', 'erp-workspace', 'legacy-client']);
        expect(r.counts).toMatchObject({ projects: 3, portraits: 1, buddyDays: 1, buddyThumbs: 1, chapters: 1 });
        expect(await prisma.observation.count({ where: { project: 'legacy-client' } })).toBe(0);
        expect(await prisma.project.count({ where: { key: 'legacy-client' } })).toBe(0);
        const state = await prisma.buddyState.findUniqueOrThrow({ where: { userId: owner.id } });
        expect([state.who, state.heading, state.now, state.notebook, state.enabled]).toEqual([null, null, null, null, true]);
        expect(await snapshot()).toMatchObject({ buddyDays: 0, chapters: 0, thumbs: 0 });
        expect(Object.values(await countOfficeRowsLeft(db, r.keys)).every((n) => n === 0)).toBe(true);
    });
});
