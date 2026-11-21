// Catching up (MCP_MEMORY_PLAN §4.7, stage 3): saved details the buddy's AI could not read when they were saved wait
// on their notes (Observation.waitingSince). When the AI can run again, a short gap (everything said in the last 48
// hours) is read as normal pieces: late delivery. A longer gap is a catch-up run: code settles the record first
// (each chain of corrections to its newest version; what was forgotten, deleted or marked wrong left out, and
// inferences; progress folded into counts), then only what can be in motion is read, oldest first, in batches of
// 15, each line with its own day, marked `via: 'catchup'`. Old words build history; what ended ends; nothing in a
// catch-up writes a question, a pulse, a notification or a lock line. Bounded: at most 150 things a run.
//
//   catchUpPass      the capture pass: people with waiting details whose AI can run again
//   catchUpIfDue     one person
//   catchUpBlock     the night's note that a catch-up happened, with its dates
//   upkeepMemories   the code-only fading and promotion, nightly for every account (AI or not)
import type { BuddyCatchUp, Memory, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { addDays, dayOf, type DayString } from '../learning';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { MOTION_KINDS, queueSavedNotes } from './memory.service';
import { buddyMaySpend } from './spend';

export const SHORT_GAP_MS = 48 * 3600_000;
export const CATCHUP_MAX_THINGS = 150;
export const CATCHUP_BATCH = 15;
/** Something the person moved on from in this many days is read, so it is known as over (§4.7 step 2). */
export const ENDED_IN_VIEW_DAYS = 180;
const WAITING_READ_MAX = 3000;

interface WaitingNote {
    id: string;
    text: string;
    saidAt: Date | null;
    createdAt: Date;
    basis: string | null;
    updateKind: string | null;
    memoryId: string | null;
    source: string;
}

const saidOf = (n: Pick<WaitingNote, 'saidAt' | 'createdAt'>) => (n.saidAt ?? n.createdAt).getTime();
const fmt = (t: number, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(t));

/** The newest version of each memory, following the chains of corrections in memory (no per-row query); `path` gets each chain's ids. */
async function heads(userId: string, ids: readonly string[], path: Map<string, string[]> = new Map()): Promise<Map<string, Memory>> {
    const all = new Map<string, Memory>();
    let frontier = [...new Set(ids)];
    for (const m of await prisma.memory.findMany({ where: { userId, id: { in: frontier } } })) all.set(m.id, m);
    for (let i = 0; i < 20 && frontier.length; i++) {
        const next = await prisma.memory.findMany({ where: { userId, supersedesId: { in: frontier } }, orderBy: { createdAt: 'asc' } });
        for (const m of next) all.set(m.id, m);
        frontier = next.map((m) => m.id);
    }
    const successor = new Map<string, Memory>();
    for (const m of all.values()) if (m.supersedesId) successor.set(m.supersedesId, m);
    const out = new Map<string, Memory>();
    for (const id of ids) {
        let m = all.get(id);
        const chain = m ? [m.id] : [];
        for (let i = 0; m && i < 50 && successor.has(m.id); i++) {
            m = successor.get(m.id);
            if (m) chain.push(m.id);
        }
        if (m) {
            out.set(id, m);
            path.set(id, chain);
        }
    }
    return out;
}

/** One person: a short gap read as pieces, a long one as a catch-up run; null when nothing is due. */
export async function catchUpIfDue(userId: string, now: Date = new Date()): Promise<'short' | 'long' | null> {
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { enabled: true, loop: true } });
    if (!state?.enabled || !state.loop) return null;
    const running = await prisma.buddyCatchUp.findFirst({ where: { userId, state: 'running' }, orderBy: { startedAt: 'desc' } });
    if (running) {
        // Its pieces are queued: the run is done once the last one was read (a cap stops it cleanly; it goes on later).
        if (!(await prisma.buddyChunk.count({ where: { userId, via: 'catchup' } }))) await prisma.buddyCatchUp.update({ where: { id: running.id }, data: { state: 'done', finishedAt: now } });
        return null;
    }
    if ((await buddyMaySpend(userId, now)) !== 'ok') return null;
    const waiting: WaitingNote[] = await prisma.observation.findMany({
        where: { userId, waitingSince: { not: null } },
        orderBy: [{ saidAt: 'asc' }, { createdAt: 'asc' }],
        take: WAITING_READ_MAX,
        select: { id: true, text: true, saidAt: true, createdAt: true, basis: true, updateKind: true, memoryId: true, source: true },
    });
    if (!waiting.length) return null;
    const ctx = await loadLearningContext(userId, now);
    const ids = waiting.map((n) => n.id);
    const clear = () => prisma.observation.updateMany({ where: { userId, id: { in: ids } }, data: { waitingSince: null } });

    // A short gap is late delivery: normal pieces, by where they came from.
    if (now.getTime() - Math.min(...waiting.map(saidOf)) <= SHORT_GAP_MS) {
        const read = waiting.filter((n) => n.basis !== 'inferred');
        for (const source of [...new Set(read.map((n) => n.source))]) {
            await queueSavedNotes(userId, source as never, read.filter((n) => n.source === source).map((n) => ({ id: n.id, text: n.text, basis: n.basis })), now, ctx.today);
        }
        await clear();
        return 'short';
    }

    // A long gap: code settles the record first.
    const chains = new Map<string, string[]>();
    const head = await heads(userId, waiting.map((n) => n.memoryId).filter((x): x is string => !!x), chains);
    const things = new Map<string, { head: Memory; notes: WaitingNote[]; versions: Set<string> }>();
    for (const n of waiting) {
        if (n.basis === 'inferred' || !n.memoryId) continue;
        const m = head.get(n.memoryId);
        if (!m || m.status === 'wrong' || !MOTION_KINDS.has(m.kind)) continue;
        if (m.status === 'closed') {
            // Ended by them (dropped, finished) lately: read, so it is known as over. Forgotten or closed on /you: left out (R6).
            const ended = /^(Dropped|Finished):/.test(m.closeReason ?? '') && !!m.closedDay && fromDbDay(m.closedDay) >= addDays(ctx.today, -ENDED_IN_VIEW_DAYS);
            if (!ended) continue;
        }
        const thing = things.get(m.id) ?? { head: m, notes: [], versions: new Set<string>() };
        thing.notes.push(n);
        for (const id of chains.get(n.memoryId) ?? []) thing.versions.add(id);
        things.set(m.id, thing);
    }
    // Bounded: the newest 150 things; older ones stay in the record and are found by search.
    const picked = [...things.values()]
        .sort((a, b) => Math.max(...b.notes.map(saidOf)) - Math.max(...a.notes.map(saidOf)))
        .slice(0, CATCHUP_MAX_THINGS)
        .reverse();
    // Progress on any version of a thing since the gap began, waiting or linked by code (update_memory's never waits).
    const since = new Date(Math.min(...waiting.map(saidOf)));
    const progress = await prisma.observation.findMany({
        where: { userId, memoryId: { in: picked.flatMap((t) => [...t.versions]) }, updateKind: { in: ['done', 'progress', 'skipped'] }, OR: [{ basis: null }, { basis: 'said' }], createdAt: { gte: since } },
        select: { id: true, text: true, saidAt: true, createdAt: true, basis: true, updateKind: true, memoryId: true, source: true },
    });
    const lines = picked.map(({ head: m, notes, versions }) => {
        // Progress folds into counts and dates (§4.7): "done on 41 days, 2 Jun to 17 Nov; skipped 3".
        const mine = [...new Map([...notes, ...progress.filter((p) => p.memoryId && versions.has(p.memoryId))].map((n) => [n.id, n])).values()];
        const done = mine.filter((n) => n.updateKind === 'done' || n.updateKind === 'progress');
        const days = new Set(done.map((n) => dayOf(new Date(saidOf(n)), ctx.tz)));
        const skipped = mine.filter((n) => n.updateKind === 'skipped').length;
        const fold = days.size ? ` (done on ${days.size} ${days.size === 1 ? 'day' : 'days'}, ${fmt(Math.min(...done.map(saidOf)), ctx.tz)} to ${fmt(Math.max(...done.map(saidOf)), ctx.tz)}${skipped ? `; skipped ${skipped}` : ''})` : '';
        const ended = m.status === 'closed' ? ` [ended ${m.closedDay ? fromDbDay(m.closedDay) : ''}: ${m.closeReason}]` : '';
        const last = m.status === 'closed' && m.closedDay ? new Date(`${fromDbDay(m.closedDay)}T12:00:00Z`).getTime() : Math.max(...mine.map(saidOf));
        return { at: new Date(last).toISOString(), text: `${m.text}${fold}${ended}`.slice(0, 600), noteId: notes[0]!.id, basis: 'said' };
    });
    const said = waiting.map(saidOf);
    const run = await prisma.buddyCatchUp.create({
        data: {
            userId,
            reason: 'ai_back',
            firstDay: toDbDay(dayOf(new Date(Math.min(...said)), ctx.tz)),
            lastDay: toDbDay(dayOf(new Date(Math.max(...said)), ctx.tz)),
            notes: waiting.length,
            things: lines.length,
            batches: Math.ceil(lines.length / CATCHUP_BATCH),
            state: lines.length ? 'running' : 'done',
            ...(lines.length ? {} : { finishedAt: now }),
        },
    });
    for (let i = 0; i < lines.length; i += CATCHUP_BATCH) {
        const batch = lines.slice(i, i + CATCHUP_BATCH);
        await prisma.buddyChunk.create({
            data: {
                userId,
                sessionKey: `catchup:${run.id}:${i / CATCHUP_BATCH}`.slice(0, 80),
                seq: 1,
                source: 'agent',
                via: 'catchup',
                noteId: batch[0]!.noteId,
                saidFrom: new Date(batch[0]!.at),
                messages: batch as unknown as Prisma.InputJsonValue,
                createdAt: new Date(now.getTime() + i),
            },
            select: { id: true },
        });
    }
    await clear();
    return 'long';
}

/** The capture pass: people with saved details waiting, a few at a time. */
export async function catchUpPass(now: Date = new Date()): Promise<number> {
    const people = await prisma.observation.groupBy({ by: ['userId'], where: { waitingSince: { not: null } }, _count: { _all: true }, orderBy: { userId: 'asc' }, take: 20 });
    const running = await prisma.buddyCatchUp.findMany({ where: { state: 'running' }, select: { userId: true }, take: 50 });
    let n = 0;
    for (const userId of new Set([...people.map((p) => p.userId), ...running.map((r) => r.userId)])) {
        try {
            if (await catchUpIfDue(userId, now)) n++;
        } catch (err) {
            console.error(`[buddy] the catch-up could not start: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return n;
}

/** The night's note (§4.7 step 5): a catch-up read saved details from these days; they are history, not today's news. */
export async function catchUpBlock(userId: string, now: Date): Promise<string | null> {
    const run: BuddyCatchUp | null = await prisma.buddyCatchUp.findFirst({ where: { userId, startedAt: { gte: new Date(now.getTime() - 36 * 3600_000) } }, orderBy: { startedAt: 'desc' } });
    if (!run || !run.firstDay || !run.lastDay || !run.things) return null;
    return `<caught_up>Since the last night the buddy read saved details from ${fromDbDay(run.firstDay)} to ${fromDbDay(run.lastDay)} that it could not read when they were saved (a catch-up: ${run.things} things). They are history with their own dates, not today's news: do not greet them as new, and ask about nothing that ended.</caught_up>`;
}

let upkeptOn: DayString | null = null;

/**
 * The code-only upkeep (§4.7): fading and promotion, once a day for every account with working memories, whether or
 * not its AI can run (before, it ran only inside the AI's night).
 */
export async function upkeepMemories(now: Date = new Date()): Promise<number> {
    const day = dayOf(now, 'UTC');
    if (upkeptOn === day) return 0;
    upkeptOn = day;
    const { fadeMemories } = await import('./think');
    const users = await prisma.memory.groupBy({ by: ['userId'], where: { status: 'active', lasting: false } });
    let faded = 0;
    for (const { userId } of users) {
        try {
            const { today } = await loadLearningContext(userId, now);
            faded += await fadeMemories(userId, today);
        } catch (err) {
            console.error(`[buddy] the nightly upkeep failed for one account: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return faded;
}

/** Tests: the upkeep runs again the same day. */
export const resetUpkeepForTests = () => {
    upkeptOn = null;
};
