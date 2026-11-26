// Routines (BUDDY_MEMORY_PLAN §3.6, B6): the standing yes. After he accepts the same kind of the
// buddy's items three times in 30 days, the buddy asks once whether to do it by itself; a yes makes a
// Routine (listed on /you with a switch). The night runs his routines before it thinks, through the
// same services agents use, each act an agent edit he can undo from Home, and names them in its note.
// Only acts that change with an Undo: anything outward or final stays his tap.
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { addDays, isValidDay, type DayString } from '../learning';
import { fromDbDayOrNull, loadLearningContext, toDbDay } from '../learningDb/common';
import { createTask } from '../tasks/tasks.service';
import { createFocusItem } from '../learningDb/focus.service';
import { moveOffBusyDays } from '../learningDb/plan.service';
import { weekStartOf, weekTargets } from '../learningDb/week.service';
import { quoted, recordAgentEdit } from '../agent/agentEditLog';
import { notFound } from '../learning/http';

export const ACCEPTS_FOR_OFFER = 3;

/** The routines there are, by kind: what accepting an item of which kind leads to, and their words. */
export const ROUTINES = {
    auto_task: {
        itemKind: 'task',
        title: 'Adds the tasks you mention with a day',
        offer: 'Add the tasks you mention with a day by itself from now on?',
    },
    auto_focus: {
        itemKind: 'focus_line',
        title: "Sets the day's first focus line from your week's targets",
        offer: "Set each day's first focus line from your week's targets by itself?",
    },
    // Not from three accepts: offered the first time he marks a busy stretch (his own act is the sign).
    auto_busy: {
        itemKind: 'busy_days',
        title: 'Moves the reviews that don’t fit your busy days to after them',
        offer: 'You’re busy for a few days. Move the reviews that won’t fit to after it, by itself, whenever you’re busy?',
    },
} as const;
export type RoutineKind = keyof typeof ROUTINES;

export interface RoutineJson {
    _id: string;
    kind: string;
    title: string;
    enabled: boolean;
    runs: number;
    lastRunDay: DayString | null;
    createdAt: string;
}

export async function listRoutines(userId: string): Promise<RoutineJson[]> {
    const rows = await prisma.routine.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({ _id: r.id, kind: r.kind, title: r.title, enabled: r.enabled, runs: r.runs, lastRunDay: fromDbDayOrNull(r.lastRunDay), createdAt: r.createdAt.toISOString() }));
}

export async function setRoutineEnabled(userId: string, id: string, enabled: boolean): Promise<RoutineJson> {
    const r = await prisma.routine.findFirst({ where: { id, userId } });
    if (!r) throw notFound();
    await prisma.routine.update({ where: { id: r.id }, data: { enabled } });
    return (await listRoutines(userId)).find((x) => x._id === r.id)!;
}

/** His yes to the offer (the routine suggestion's accept). */
export async function createRoutine(userId: string, kind: string): Promise<void> {
    if (!(kind in ROUTINES)) return;
    const def = ROUTINES[kind as RoutineKind];
    await prisma.routine.upsert({ where: { userId_kind: { userId, kind } }, create: { userId, kind, title: def.title }, update: { enabled: true } });
}

/** After he accepts one of the buddy's items: the third of its kind in 30 days brings the offer, once ever. */
export async function maybeOfferRoutine(userId: string, acceptedKind: string, now: Date = new Date()): Promise<boolean> {
    const entry = (Object.entries(ROUTINES) as Array<[RoutineKind, (typeof ROUTINES)[RoutineKind]]>).find(([, d]) => d.itemKind === acceptedKind);
    // Only the routines his accepts lead to (the busy one has its own offer).
    if (!entry || (entry[1].itemKind !== 'task' && entry[1].itemKind !== 'focus_line')) return false;
    const [kind, def] = entry as [RoutineKind, { itemKind: 'task' | 'focus_line'; title: string; offer: string }];
    if (await prisma.routine.findUnique({ where: { userId_kind: { userId, kind } }, select: { id: true } })) return false;
    if (await prisma.suggestion.findFirst({ where: { userId, kind: 'routine', payload: { path: ['routine'], equals: kind } }, select: { id: true } })) return false;
    const accepted = await prisma.suggestion.count({
        where: { userId, ...(def.itemKind === 'task' ? { proposedBy: 'buddy' as const } : {}), kind: def.itemKind, status: 'accepted', decidedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
    });
    if (accepted < ACCEPTS_FOR_OFFER) return false;
    const { today } = await loadLearningContext(userId, now);
    await prisma.suggestion.create({
        data: { userId, kind: 'routine', text: def.offer, reason: `You took ${accepted} of these this month`, payload: { routine: kind } as Prisma.InputJsonValue, proposedBy: 'buddy', status: 'pending', expiresDay: toDbDay(addDays(today, 14)) },
    });
    return true;
}

/** The first busy stretch brings the busy-day offer, once ever (the night asks, before it runs routines). */
export async function maybeOfferBusyRoutine(userId: string, now: Date = new Date()): Promise<boolean> {
    const { today, user } = await loadLearningContext(userId, now);
    const until = fromDbDayOrNull(user.busyUntil);
    if (!until || until < today) return false;
    if (await prisma.routine.findUnique({ where: { userId_kind: { userId, kind: 'auto_busy' } }, select: { id: true } })) return false;
    if (await prisma.suggestion.findFirst({ where: { userId, kind: 'routine', payload: { path: ['routine'], equals: 'auto_busy' } }, select: { id: true } })) return false;
    await prisma.suggestion.create({
        data: { userId, kind: 'routine', text: ROUTINES.auto_busy.offer, reason: `You marked yourself busy until ${until}`, payload: { routine: 'auto_busy' } as Prisma.InputJsonValue, proposedBy: 'buddy', status: 'pending', expiresDay: toDbDay(until) },
    });
    return true;
}

/** The night runs his routines first; answers what was done, in words, for its note. */
export async function runRoutines(userId: string, now: Date = new Date()): Promise<string[]> {
    await maybeOfferBusyRoutine(userId, now);
    const routines = await prisma.routine.findMany({ where: { userId, enabled: true } });
    if (!routines.length) return [];
    const { today } = await loadLearningContext(userId, now);
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { name: true } });
    const actor = { userId, agentName: state?.name || 'Kaaga', tokenId: null };
    const done: string[] = [];
    for (const r of routines) {
        let runs = 0;
        if (r.kind === 'auto_task') {
            const items = await prisma.suggestion.findMany({ where: { userId, proposedBy: 'buddy', kind: 'task', status: { in: ['candidate', 'pending'] } }, orderBy: { createdAt: 'asc' }, take: 10 });
            for (const item of items) {
                const p = (item.payload ?? {}) as Record<string, unknown>;
                const due = typeof p['dueDay'] === 'string' && isValidDay(p['dueDay']) && p['dueDay'] >= today ? (p['dueDay'] as DayString) : null;
                if (!due) continue;
                const claimed = await prisma.suggestion.updateMany({ where: { id: item.id, status: { in: ['candidate', 'pending'] } }, data: { status: 'accepted', decidedAt: now } });
                if (claimed.count === 0) continue;
                const task = await createTask(userId, { title: String(p['title'] ?? item.text), due }, now);
                await recordAgentEdit(actor, { kind: 'task_create', summary: `Added the task ${quoted(task.title)} (due ${due}) by itself`, entityId: task._id });
                done.push(`added the task ${quoted(task.title)} for ${due}`);
                runs++;
            }
        }
        if (r.kind === 'auto_focus') {
            // Only on a day without a focus line yet, and only from a week target still open.
            const lines = await prisma.focusItem.count({ where: { userId, day: toDbDay(today) } });
            const ctx = await loadLearningContext(userId, now);
            const open = lines ? [] : (await weekTargets(userId, weekStartOf(today), ctx.tz)).filter((t) => !t.done);
            const text = open[0]?.text.replace(/\s+/g, ' ').trim().slice(0, 140);
            if (text) {
                const item = await createFocusItem(userId, text, now);
                await recordAgentEdit(actor, { kind: 'focus_add', summary: `Set today's focus line ${quoted(text)} from the week by itself`, entityId: item._id });
                done.push(`set today's focus line to ${quoted(text)} from the week`);
                runs++;
            }
        }
        if (r.kind === 'auto_busy') {
            const moved = await moveOffBusyDays(userId, now);
            if (moved.changes.length && moved.until) {
                await recordAgentEdit(actor, { kind: 'revisions_spread', summary: `Moved ${moved.moved} ${moved.moved === 1 ? 'review' : 'reviews'} off your busy days to after ${moved.until}`, undoData: { changes: moved.changes } });
                done.push(`moved ${moved.moved} ${moved.moved === 1 ? 'review' : 'reviews'} that didn't fit the busy days to after ${moved.until}`);
                runs++;
            }
        }
        if (runs) await prisma.routine.update({ where: { id: r.id }, data: { runs: { increment: runs }, lastRunDay: toDbDay(today) } });
    }
    return done;
}
