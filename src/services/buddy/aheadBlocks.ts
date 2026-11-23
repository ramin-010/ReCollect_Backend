// Stage 17 (ECOSYSTEM_V2_PLAN, "Buddy brings it up while there is still time"): what the night and the pulses see of
// what is ahead, from the one reader (services/ahead): <left_off>, the problems and topics they stopped before finishing
// this week (with where they stopped), and <coming_up>, their dated to-dos of the next seven days (events are already in
// <threads> with their day). The ids shown are the refs a line may rest on: a ref that closes (the task ticked, the
// problem solved, a study session started since the line's hours began, a Later on it) takes the words off at once
// (asks.ts stillTrue), with no pulse.
import { prisma } from '../../db/prisma';
import type { Prisma } from '@prisma/client';
import { addDays, dayOf, type DayString } from '../learning';
import { fromDbDay, toDbDay } from '../learningDb/common';
import { countedSessions } from '../learningDb/lens';
import { aheadFor } from '../ahead/ahead.service';
import { leftOff, LEFT_OFF_DAYS } from '../ahead/aheadRules';
import { laterHidden } from '../ahead/ahead.service';
import { laterBlock } from '../ahead/later';
import type { Line } from './think';

/** At most this many of each in the night's input. */
export const LEFT_OFF_MAX = 3;
export const COMING_UP_MAX = 8;

const dayWords = (day: DayString) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${day}T12:00:00Z`)).replace(',', '');

export interface AheadBlocks {
    /** The two tags for the request (empty when there is nothing ahead). */
    text: string;
    /** The ids shown (pu_…, tk_…): a line, the thought or the note may rest on them. */
    refs: Set<string>;
    /** Their words, for the number guard (a line may say "3Sum" or "by Sun 22 Nov"). */
    sources: string;
}

/** The night's and the pulse's view of what is ahead (the loop on). */
export async function aheadBlocks(userId: string, now: Date, tz: string): Promise<AheadBlocks> {
    const ahead = await aheadFor(userId, now, { tz, aheadMax: COMING_UP_MAX + 4, leftMax: LEFT_OFF_MAX });
    const tasks = ahead.comingUp.filter((r) => r.kind === 'task').slice(0, COMING_UP_MAX);
    const left = ahead.leftOff.slice(0, LEFT_OFF_MAX);
    const lines: string[] = [];
    if (left.length) lines.push(`<left_off>\n${left.map((r) => `${r.id} · ${r.what ?? 'study'} · "${r.text}" · left ${dayWords(r.day)}${r.detail ? ` · where they stopped: ${r.detail}` : ''}`).join('\n')}\n</left_off>`);
    if (tasks.length) lines.push(`<coming_up>\n${tasks.map((r) => `${r.id} · "${r.text}" · due ${dayWords(r.day)}${r.when ? ` at ${r.at.replace(/^\S+\s/, '')}` : ''}`).join('\n')}\n</coming_up>`);
    // Stage 19: their last Laters (what they put off from the widget, and to when): their timing, in their taps; 11-21: the
    // ones still to come back carry their ids, so a line can bring the nudge back at its time.
    const later = await laterBlock(userId, now, tz);
    if (later.text) lines.push(later.text);
    const shown = [...left, ...tasks];
    return {
        text: lines.join('\n\n'),
        refs: new Set([...shown.map((r) => r.id), ...later.refs]),
        sources: [...shown.map((r) => `${r.text} ${r.detail ?? ''} ${dayWords(r.day)} ${r.at}`), later.sources].filter(Boolean).join('\n'),
    };
}

/** The ids a step named that it was shown as refs (the rest are threads, or nothing it was given). */
export function refsOf(ids: readonly string[] | undefined, shown: ReadonlySet<string>): string[] {
    return [...new Set((ids ?? []).filter((id) => shown.has(id)))];
}

/** A step's thought or note `about`, stored with its refs beside the threads (older readers skip them: parseAbout). */
export function aboutJson(about: readonly unknown[], refs: readonly string[]): Prisma.InputJsonValue {
    return [...about, ...refs.map((ref) => ({ ref }))] as unknown as Prisma.InputJsonValue;
}

/** The refs stored in a thought's or note's `about` (stage 17). */
export function parseRefs(value: Prisma.JsonValue | undefined | null): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((v) => (v && typeof v === 'object' && typeof (v as { ref?: unknown }).ref === 'string' ? [(v as { ref: string }).ref] : []));
}

/**
 * The left-off items a line rested on yesterday: a line about the same one today is dropped ("two days running"), so
 * a pick-up nudge never becomes a daily nag.
 */
export async function leftOffSaidYesterday(userId: string, today: DayString): Promise<Set<string>> {
    const steps = await prisma.buddyDay.findMany({ where: { userId, day: toDbDay(addDays(today, -1)) }, select: { lines: true } });
    const out = new Set<string>();
    for (const s of steps) for (const l of (Array.isArray(s.lines) ? s.lines : []) as unknown as Line[]) for (const r of l.refs ?? []) if (r.startsWith('pu_')) out.add(r);
    return out;
}

/**
 * Which refs are still open now (stage 17, true when shown): a task not done; a left-off item still left off (not
 * solved, not done, no later session on it, not being worked on now) with no study or practice session started since
 * `since`; neither under a pending Later. Returns a check per ref and moment.
 */
export async function refsChecker(userId: string, refs: readonly string[], now: Date, tz: string): Promise<(ref: string, since: Date | null) => boolean> {
    const taskIds = refs.filter((r) => r.startsWith('tk_')).map((r) => r.slice(3));
    const wantsSessions = refs.some((r) => r.startsWith('pu_'));
    const from = addDays(dayOf(now, tz), -(LEFT_OFF_DAYS - 1));
    const counted = wantsSessions ? await countedSessions(userId) : {};
    const [tasks, sessions, hidden] = await Promise.all([
        taskIds.length ? prisma.todo.findMany({ where: { userId, id: { in: taskIds } }, select: { id: true, status: true } }) : Promise.resolve([]),
        wantsSessions
            ? prisma.workSession.findMany({
                  where: { userId, kind: { in: ['practice', 'study'] }, day: { gte: toDbDay(from) }, ...counted },
                  select: { id: true, kind: true, problem: true, outcome: true, topicId: true, nextStep: true, url: true, day: true, startedAt: true, updatedAt: true, topic: { select: { title: true, status: true, docId: true, nextStep: true } } },
                  orderBy: { startedAt: 'desc' },
                  take: 60,
              })
            : Promise.resolve([]),
        laterHidden(userId, now),
    ]);
    const openTasks = new Set(tasks.filter((t) => t.status !== 'complete').map((t) => `tk_${t.id}`));
    const stillLeft = new Set(
        leftOff(
            {
                now,
                tz,
                sessions: sessions.map((s) => ({
                    id: s.id,
                    kind: s.kind,
                    problem: s.problem,
                    outcome: s.outcome,
                    topicId: s.topicId,
                    topicTitle: s.topic?.title ?? null,
                    topicDone: s.topic?.status === 'done' || s.topic?.status === 'skipped',
                    nextStep: s.nextStep ?? s.topic?.nextStep ?? null,
                    url: s.url,
                    docId: s.topic?.docId ?? null,
                    day: fromDbDay(s.day),
                    startedAt: s.startedAt,
                    updatedAt: s.updatedAt,
                })),
            },
            true,
            99
        ).map((r) => r.id)
    );
    const lastStart = sessions.reduce((m, s) => Math.max(m, s.startedAt.getTime()), 0);
    return (ref: string, since: Date | null) => {
        if (hidden.has(ref)) return false;
        if (ref.startsWith('tk_')) return openTasks.has(ref);
        if (ref.startsWith('pu_')) return stillLeft.has(ref) && !(since && lastStart >= since.getTime());
        return true;
    };
}
