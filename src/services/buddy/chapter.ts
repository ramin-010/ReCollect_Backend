// The month's chapter and the audit (BUDDY_MEMORY_PLAN §3.7, B7): on the 1st (or the first night
// after it), one Opus call writes the month just ended as a chapter of at most 150 words from that
// month's numbers (worked out by code), its notes and its memory changes; audits the memories (merges
// what says the same, closes what newer notes contradict); asks him at most two "Still true?"
// questions; and rebuilds "who he is" and "where he is heading" from the lasting memories alone, so
// small rewordings never pile up. Code checks it all; a chapter with a number it was not given becomes
// a plain one written by code.
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { callClaude } from '../claude/client';
import { recordAiUsage } from '../claude/usage.service';
import { parseJson, responseText } from '../recall/output';
import { withRefusalFallbacks, type CreateParams } from '../recall/prompts';
import type { DayString } from '../learning';
import { dayRange, loadLearningContext } from '../learningDb/common';
import { characterPrompt } from './character';
import { MEMORY_KINDS } from './memory.service';
import { scrubSecrets } from './scrub';
import { THINK_MODEL, applyOps, checkOps, strayNumbers, type NightOp } from './think';

const EPHEMERAL = { type: 'ephemeral' } as const;
const CHAPTER_WORDS = 150;
const QUESTIONS_MAX = 2;

const CHAPTER_JOB = `It is the first of the month. Look back at the month that ended and answer with one JSON object:
- chapter: the month as a short chapter of his life, at most ${CHAPTER_WORDS} words, in the third person: what he worked on, what changed, what weighed on him, what went well. Only what the facts and notes show; every number must be one you were given.
- merge: memories that say the same thing (ids, the merged text, kind). close: memories newer notes contradict (id, reason). Never memories marked "his own".
- questions: at most ${QUESTIONS_MAX} memories you are least sure of, each with a short question to him ("Still true? You study after 9 pm"), or none.
- who (at most 120 words) and heading (at most 80 words): written again from the lasting memories alone, not from any earlier text.`;

const str = { type: 'string' } as const;
export const CHAPTER_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['chapter', 'merge', 'close', 'questions', 'who', 'heading'],
    properties: {
        chapter: str,
        merge: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ids', 'text', 'kind'], properties: { ids: { type: 'array', items: str }, text: str, kind: { type: 'string', enum: [...MEMORY_KINDS] } } } },
        close: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id: str, reason: str } } },
        questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'question'], properties: { id: str, question: str } } },
        who: str,
        heading: str,
    },
};

const zChapter = z.object({
    chapter: z.string(),
    merge: z.array(z.object({ ids: z.array(z.string()), text: z.string(), kind: z.enum(MEMORY_KINDS) })),
    close: z.array(z.object({ id: z.string(), reason: z.string() })),
    questions: z.array(z.object({ id: z.string(), question: z.string() })),
    who: z.string(),
    heading: z.string(),
});

export interface MonthFacts {
    month: string;
    minutes: Record<string, number>;
    activeDays: number;
    sessions: number;
    topProjects: Array<{ name: string; minutes: number }>;
    reviewsDone: number;
    tasksDone: number;
    memoriesAdded: number;
    memoriesClosed: number;
    notes: number;
}

const monthStart = (month: string) => `${month}-01` as DayString;
const nextMonth = (month: string) => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const prevMonth = (month: string) => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/** The month's numbers, by code. */
export async function monthFacts(userId: string, month: string, tz: string): Promise<MonthFacts> {
    const from = dayRange(monthStart(month), tz).gte;
    const to = dayRange(monthStart(nextMonth(month)), tz).gte;
    const [sessions, reviews, tasks, added, closed, notes] = await Promise.all([
        prisma.workSession.findMany({ where: { userId, startedAt: { gte: from, lt: to } }, select: { kind: true, minutes: true, day: true, project: { select: { name: true } } } }),
        prisma.revision.count({ where: { userId, status: 'done', completedAt: { gte: from, lt: to } } }),
        prisma.todo.count({ where: { userId, workspaceId: null, completedAt: { gte: from, lt: to } } }),
        prisma.memory.count({ where: { userId, createdAt: { gte: from, lt: to } } }),
        prisma.memory.count({ where: { userId, status: { in: ['closed', 'wrong'] }, updatedAt: { gte: from, lt: to } } }),
        prisma.observation.count({ where: { userId, createdAt: { gte: from, lt: to } } }),
    ]);
    const minutes: Record<string, number> = {};
    const projects = new Map<string, number>();
    for (const s of sessions) {
        minutes[s.kind] = (minutes[s.kind] ?? 0) + (s.minutes ?? 0);
        if (s.project) projects.set(s.project.name, (projects.get(s.project.name) ?? 0) + (s.minutes ?? 0));
    }
    return {
        month,
        minutes,
        activeDays: new Set(sessions.map((s) => s.day.toISOString().slice(0, 10))).size,
        sessions: sessions.length,
        topProjects: [...projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, m]) => ({ name, minutes: m })),
        reviewsDone: reviews,
        tasksDone: tasks,
        memoriesAdded: added,
        memoriesClosed: closed,
        notes,
    };
}

/** A plain chapter by code, when the model's fails a check. */
export function plainChapter(f: MonthFacts): string {
    const total = Object.values(f.minutes).reduce((a, m) => a + m, 0);
    const hours = Math.round(total / 60);
    return `In ${f.month}: ${hours} hours logged over ${f.activeDays} active days, ${f.reviewsDone} reviews and ${f.tasksDone} tasks done${f.topProjects[0] ? `, most of it on ${f.topProjects[0].name}` : ''}.`;
}

/** The month's chapter and audit for one user; `month` defaults to the one that just ended. */
export async function runMonth(userId: string, now: Date = new Date(), month?: string): Promise<{ period: string; questions: number; ops: number; costUsd: number }> {
    const ctx = await loadLearningContext(userId, now);
    const period = month ?? prevMonth(ctx.today.slice(0, 7));
    const facts = await monthFacts(userId, period, ctx.tz);
    const from = dayRange(monthStart(period), ctx.tz).gte;
    const to = dayRange(monthStart(nextMonth(period)), ctx.tz).gte;
    const [state, memories, steps] = await Promise.all([
        prisma.buddyState.findUnique({ where: { userId } }),
        prisma.memory.findMany({ where: { userId, status: 'active' }, orderBy: [{ lasting: 'desc' }, { lastSeenDay: 'desc' }], take: 220 }),
        prisma.buddyDay.findMany({ where: { userId, kind: 'night', createdAt: { gte: from, lt: to } }, select: { note: true }, orderBy: { createdAt: 'asc' }, take: 31 }),
    ]);
    const memLine = (m: (typeof memories)[number]) => `${m.id} · ${m.kind} · ${m.lasting ? 'lasting' : 'working'}${m.byUser ? ' · his own' : ''} · seen ${m.seenCount} · ${m.text}`;
    const text = [
        `<month>${period}</month>`,
        `<facts>\n${JSON.stringify(facts)}\n</facts>`,
        `<memories>\n${memories.map(memLine).join('\n') || 'none'}\n</memories>`,
        `<month_notes>\n${steps.map((s) => s.note).filter(Boolean).map((n) => (n!.length > 240 ? `${n!.slice(0, 239)}…` : n)).join('\n') || 'none'}\n</month_notes>`,
        'Write this month’s chapter and audit.',
    ].join('\n\n');
    const request = {
        model: THINK_MODEL,
        max_tokens: 12_000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: CHAPTER_SCHEMA } },
        system: [{ type: 'text', text: `${characterPrompt({ name: state?.name ?? null, tone: state?.tone === 'gentle' ? 'gentle' : 'candid' })}\n\n${CHAPTER_JOB}`, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    } as CreateParams;
    const message = await callClaude(withRefusalFallbacks(request), 'buddy chapter');
    const cost = (await recordAiUsage(userId, 'buddy_think', message)).costUsd;
    const out = zChapter.parse(parseJson(responseText(message)));

    // The audit's changes go through the night's own checks.
    const blank = { id: '', ids: [], kind: '' as const, lasting: false, text: '', private: false, tags: [], from: [], reason: '' };
    const ops: NightOp[] = [
        ...out.merge.map((m): NightOp => ({ ...blank, op: 'merge', ids: m.ids, text: m.text, kind: m.kind })),
        ...out.close.map((c): NightOp => ({ ...blank, op: 'close', id: c.id, reason: c.reason })),
    ];
    const { valid } = checkOps(ops, { memories: new Map(memories.map((m) => [m.id, m])), noteIds: new Set() });
    const applied = await applyOps(userId, valid, ctx.today, now);

    const sources = [JSON.stringify(facts), ...memories.map((m) => m.text), ...steps.map((s) => s.note ?? '')].join('\n');
    const words = (t: string) => t.split(/\s+/).filter(Boolean);
    const chapterText = scrubSecrets(out.chapter).trim();
    const chapter = chapterText && words(chapterText).length <= CHAPTER_WORDS + 20 && !strayNumbers(chapterText, sources).length ? chapterText : plainChapter(facts);
    const known = new Map(memories.map((m) => [m.id, m]));
    const questions = out.questions.filter((q) => known.has(q.id) && !known.get(q.id)!.byUser && q.question.trim()).slice(0, QUESTIONS_MAX).map((q) => ({ memoryId: q.id, question: q.question.trim().slice(0, 200) }));
    await prisma.buddyChapter.upsert({
        where: { userId_period: { userId, period } },
        create: { userId, period, text: chapter, facts: facts as unknown as Prisma.InputJsonValue, questions: questions as unknown as Prisma.InputJsonValue, model: message.model.slice(0, 100), costUsd: cost.toFixed(6) },
        update: { text: chapter, facts: facts as unknown as Prisma.InputJsonValue, questions: questions as unknown as Prisma.InputJsonValue, model: message.model.slice(0, 100), costUsd: cost.toFixed(6) },
    });
    const clean = (t: string, max: number) => {
        const x = scrubSecrets(t).trim();
        return x && words(x).length <= max + 10 && !strayNumbers(x, sources).length ? x : null;
    };
    const who = clean(out.who, 120);
    const heading = clean(out.heading, 80);
    if (who || heading) await prisma.buddyState.update({ where: { userId }, data: { ...(who ? { who } : {}), ...(heading ? { heading } : {}) } });
    return { period, questions: questions.length, ops: applied.length, costUsd: Math.round(cost * 1e4) / 1e4 };
}

/** The chapter of the month that ended, on the first nights of a month when it isn't written yet. */
export async function chapterIfDue(userId: string, now: Date = new Date()): Promise<boolean> {
    const ctx = await loadLearningContext(userId, now);
    if (Number(ctx.today.slice(8, 10)) > 7) return false;
    const period = prevMonth(ctx.today.slice(0, 7));
    if (await prisma.buddyChapter.findUnique({ where: { userId_period: { userId, period } }, select: { id: true } })) return false;
    // Only a month the buddy saw: its state existed before the month ended.
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { updatedAt: true } });
    if (!state) return false;
    const hasMonth = await prisma.buddyDay.count({ where: { userId, createdAt: { lt: dayRange(monthStart(ctx.today.slice(0, 7)), ctx.tz).gte } } });
    if (!hasMonth) return false;
    await runMonth(userId, now, period);
    return true;
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** His months that hold every word of the query (a month's name or "2026-03" finds that month): recall_memory. */
export async function searchChapters(userId: string, q: string, limit = 6): Promise<Array<{ period: string; text: string }>> {
    const rows = await prisma.buddyChapter.findMany({ where: { userId }, orderBy: { period: 'desc' }, take: 48, select: { period: true, text: true } });
    const words = q.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length > 1);
    if (!words.length) return rows.slice(0, limit);
    const named = (r: { period: string }) => `${r.period} ${MONTH_NAMES[Number(r.period.slice(5, 7)) - 1] ?? ''} ${r.period.slice(0, 4)}`;
    return rows.filter((r) => words.every((w) => `${named(r)} ${r.text.toLowerCase()}`.includes(w))).slice(0, limit);
}

/** His answer to a "Still true?" question: yes makes the memory his own (no model changes it), no marks it wrong. */
export async function answerQuestion(userId: string, memoryId: string, answer: 'yes' | 'no'): Promise<{ answered: true }> {
    const chapters = await prisma.buddyChapter.findMany({ where: { userId }, select: { id: true, questions: true } });
    const owner = chapters.find((c) => Array.isArray(c.questions) && (c.questions as Array<{ memoryId: string }>).some((q) => q.memoryId === memoryId));
    if (owner) {
        const rest = (owner.questions as Array<{ memoryId: string }>).filter((q) => q.memoryId !== memoryId);
        await prisma.buddyChapter.update({ where: { id: owner.id }, data: { questions: rest as unknown as Prisma.InputJsonValue } });
    }
    await prisma.memory.updateMany({ where: { id: memoryId, userId }, data: answer === 'yes' ? { byUser: true } : { status: 'wrong', byUser: true, pinned: false } });
    return { answered: true };
}

