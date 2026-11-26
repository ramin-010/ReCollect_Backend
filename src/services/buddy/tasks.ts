// Stage 5b, part A (ECOSYSTEM_V2_PLAN): something to do is a task. With the loop on, a to-do in a person's own words
// becomes one task due on its day (so it is never on today's list before that day) with one silent early reminder,
// and their own word that an open task is done ticks it. The digest proposes; code holds every rule here.
import { prisma, type TxClient } from '../../db/prisma';
import { addDays, dayOf, isValidDay, startOfDay, type DayString } from '../learning';
import { createTodoReminder } from '../reminders/reminders.service';
import { sameWords } from '../tasks/taskReminders.service';
import { quoted, recordAgentEdit, type AgentActor } from '../agent/agentEditLog';

/** The early reminder's time when their words name none: 09:00 their time (its day, or the day before for a deadline). */
export const EARLY_REMINDER_MIN = 9 * 60;
/** A task's due time when their words name none: 18:00, "by the evening" (as tasks.service reads a day). */
const DUE_MIN = 18 * 60;
const TITLE_MAX = 140;
const YEAR_MS = 366 * 86_400_000;
/** Tasks one piece may add, and close. */
const TASKS_PER_PIECE = 5;

/** Where a piece came from, when its to-dos may become tasks: their own words, heard live (never an export, a catch-up or an agent's note). */
export function tasksFromWordsOk(chunk: { source: string; via?: string | null }): boolean {
    if (chunk.source === 'agent') return false;
    return !['import', 'catchup', 'connector', 'agent'].includes(chunk.via ?? '');
}

/** "HH:mm" as minutes of the day, or null. */
export function minuteOf(hhmm: string | null | undefined): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/**
 * When the early reminder goes: at the time their words name, on its day; else 09:00 on its day, or 09:00 the day
 * before for a deadline ("by Friday": its own day when the day before has passed). Null when that time has passed
 * (a to-do for today said after 09:00 is on today's list already) or is over a year away.
 */
export function earlyReminderAt(item: { dueDay: DayString; deadline: boolean; minute: number | null }, ctx: { tz: string; now: Date }): Date | null {
    const at = (day: DayString, min: number) => new Date(startOfDay(day, ctx.tz).getTime() + min * 60_000);
    let when: Date;
    if (item.deadline) {
        const before = at(addDays(item.dueDay, -1), EARLY_REMINDER_MIN);
        when = before.getTime() > ctx.now.getTime() ? before : at(item.dueDay, EARLY_REMINDER_MIN);
    } else when = at(item.dueDay, item.minute ?? EARLY_REMINDER_MIN);
    if (when.getTime() <= ctx.now.getTime() || when.getTime() > ctx.now.getTime() + YEAR_MS) return null;
    return when;
}

/** "Mon 23 Nov" for a day. */
const dayWords = (day: DayString) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
const timeWords = (at: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(at);

export interface TaskFromWords {
    text: string;
    dueDay: string;
    deadline: boolean;
    time: string;
}

export interface TaskDrop {
    what: string;
    why: string;
}

/** Who adds them: the buddy, by its name (Home's "From your agent" row). */
export async function buddyActor(userId: string, db: TxClient | typeof prisma = prisma): Promise<AgentActor> {
    const state = await db.buddyState.findUnique({ where: { userId }, select: { name: true } });
    return { userId, agentName: state?.name || 'Kaaga', tokenId: null };
}

/**
 * Their to-dos as tasks (§5b A2, A3), inside the digest's transaction: each one due on its day (never on today's list
 * before it), with one silent early reminder, and an Undo row. Not twice: an open task with the same words due that
 * day (or with no day) is left as it is. A to-do whose day is not a real day ahead is dropped (the caller keeps it as
 * a suggestion, as before).
 */
export async function writeTasksFromWords(
    tx: TxClient,
    userId: string,
    items: readonly TaskFromWords[],
    ctx: { now: Date; tz: string; today: DayString }
): Promise<{ made: number; reminders: number; dropped: TaskDrop[] }> {
    const out = { made: 0, reminders: 0, dropped: [] as TaskDrop[] };
    if (!items.length) return out;
    const open = await tx.todo.findMany({ where: { userId, workspaceId: null, status: { not: 'complete' } }, select: { id: true, title: true, dueDate: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    const actor = await buddyActor(userId, tx);
    for (const item of items.slice(0, TASKS_PER_PIECE)) {
        const title = item.text.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
        if (!title) continue;
        if (!isValidDay(item.dueDay) || item.dueDay < ctx.today) {
            out.dropped.push({ what: `task ${title.slice(0, 40)}`, why: 'no day of its own ahead' });
            continue;
        }
        const dueDay = item.dueDay as DayString;
        if (open.some((t) => sameWords(title, t.title) && (!t.dueDate || dayOf(t.dueDate, ctx.tz) === dueDay))) {
            out.dropped.push({ what: `task ${title.slice(0, 40)}`, why: 'in their tasks already' });
            continue;
        }
        const minute = minuteOf(item.time);
        const dueDate = new Date(startOfDay(dueDay, ctx.tz).getTime() + (minute ?? DUE_MIN) * 60_000);
        const remindAt = earlyReminderAt({ dueDay, deadline: item.deadline, minute }, ctx);
        const task = await tx.todo.create({ data: { userId, title, priority: 'normal', dueDate, status: 'pending', visibility: 'private', ...(remindAt ? { reminderDate: remindAt } : {}), createdAt: ctx.now }, select: { id: true } });
        if (remindAt) {
            await createTodoReminder({ userId, todoId: task.id, reminderDate: remindAt, title, silent: true }, tx);
            out.reminders++;
        }
        await recordAgentEdit(
            actor,
            { kind: 'task_create', summary: `Added the task ${quoted(title)} for ${dayWords(dueDay)}${remindAt ? `, with a quiet reminder ${timeWords(remindAt, ctx.tz)}` : ''}, from what you said`, entityId: task.id },
            tx
        );
        open.push({ id: task.id, title, dueDate });
        out.made++;
    }
    return out;
}

/**
 * Their own word that an open task is done (§5b A4): the task is ticked and its reminders still to come are
 * cancelled (a repeating one keeps its series: a habit's tick is that day's), with an Undo row that puts both back.
 * Only a task the digest was shown, by its id; never a workspace task.
 */
export async function closeTasksFromWords(tx: TxClient, userId: string, done: ReadonlyArray<{ taskId: string }>, shown: ReadonlySet<string>, ctx: { now: Date }): Promise<{ closed: number; dropped: TaskDrop[] }> {
    const out = { closed: 0, dropped: [] as TaskDrop[] };
    if (!done.length) return out;
    const actor = await buddyActor(userId, tx);
    for (const d of [...new Map(done.map((x) => [x.taskId, x])).values()].slice(0, TASKS_PER_PIECE)) {
        if (!shown.has(d.taskId)) {
            out.dropped.push({ what: 'task done', why: 'not a task it was shown' });
            continue;
        }
        const t = await tx.todo.findFirst({ where: { id: d.taskId, userId, workspaceId: null }, select: { id: true, title: true, status: true, priority: true, dueDate: true, completedAt: true } });
        if (!t || t.status === 'complete') {
            out.dropped.push({ what: 'task done', why: 'not an open task' });
            continue;
        }
        const pending = await tx.reminder.findMany({ where: { todoId: t.id, status: 'pending', repeat: null, reminderDate: { gt: ctx.now } }, select: { id: true } });
        await tx.todo.update({ where: { id: t.id }, data: { status: 'complete', completedAt: ctx.now }, select: { id: true } });
        if (pending.length) await tx.reminder.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { status: 'cancelled' } });
        await recordAgentEdit(
            actor,
            {
                kind: 'task_update',
                summary: `Ticked ${quoted(t.title)} done, from what you said`,
                entityId: t.id,
                undoData: {
                    before: { title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate?.toISOString() ?? null, completedAt: t.completedAt?.toISOString() ?? null },
                    reminders: pending.map((p) => p.id),
                },
            },
            tx
        );
        out.closed++;
    }
    return out;
}

/** The open tasks the digest is shown (id, title, its day), newest first. */
export async function openTasksForDigest(userId: string, tz: string): Promise<Array<{ id: string; title: string; day: string | null }>> {
    const rows = await prisma.todo.findMany({ where: { userId, workspaceId: null, status: { not: 'complete' } }, select: { id: true, title: true, dueDate: true }, orderBy: { createdAt: 'desc' }, take: 30 });
    return rows.map((t) => ({ id: t.id, title: t.title, day: t.dueDate ? dayOf(t.dueDate, tz) : null }));
}
