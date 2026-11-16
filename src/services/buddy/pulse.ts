// The pulses (BUDDY_MEMORY_PLAN §3.3): at 12:00 and 18:00 his time, a lighter step (Sonnet 5.5, low
// effort) may rewrite the lines still to come and add a note, when something new arrived since the
// last step (notes from his chats, his own words, his thumbs). Nothing new: no model call. The night's
// lines for the hours gone stay; the note and follow-up carry over unless the pulse writes new ones.
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { callClaude } from '../claude/client';
import { recordAiUsage } from '../claude/usage.service';
import { parseJson, responseText } from '../recall/output';
import { withRefusalFallbacks, type CreateParams } from '../recall/prompts';
import { loadLearningContext, toDbDay } from '../learningDb/common';
import { characterPrompt } from './character';
import { buddySignals, plainLine } from './signals';
import { scrubSecrets } from './scrub';
import { FORMS, LINE_MAX, SLOTS, guardLines, lockCheck, strayNumbers, unlabel, type Line, type Slot } from './think';

export const PULSE_MODEL = process.env['BUDDY_PULSE_MODEL'] || 'claude-sonnet-5-5';
const EPHEMERAL = { type: 'ephemeral' } as const;

export const PULSE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['lines', 'note'],
    properties: {
        lines: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['slot', 'text', 'form', 'lockOk', 'sourceId'],
                properties: { slot: { type: 'string', enum: [...SLOTS] }, text: { type: 'string' }, form: { type: 'string', enum: [...FORMS] }, lockOk: { type: 'boolean' }, sourceId: { type: 'string' } },
            },
        },
        note: { type: 'string' },
    },
};

const PULSE_JOB = `It is the middle of his day. Something new arrived since you last thought (below). Rewrite only the lines for the hours still to come (the slots you are given), each at most ${LINE_MAX} characters, one thought, said the way a friend would text it (no label in front), lockOk true only if a stranger may read it; keep a line as it is when it still fits. note: a few casual sentences, like a friend's message, only if the new things truly call for one now, else "". Never repeat what you already said today.`;

const zPulse = z.object({ lines: z.array(z.object({ slot: z.enum(SLOTS), text: z.string(), form: z.enum(FORMS), lockOk: z.boolean(), sourceId: z.string() })), note: z.string() });

const hourIn = (tz: string, at: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(at)) % 24;

/** A pulse for one user when one is due (12:00 and 18:00) and something new arrived; null otherwise. */
export async function pulseIfDue(userId: string, now: Date = new Date()): Promise<{ ran: boolean; reason: string; costUsd?: number }> {
    const ctx = await loadLearningContext(userId, now);
    const hour = hourIn(ctx.tz, now);
    if (hour < 12) return { ran: false, reason: 'not yet noon' };
    const steps = await prisma.buddyDay.findMany({ where: { userId, day: toDbDay(ctx.today) }, orderBy: { createdAt: 'asc' } });
    const night = steps.find((s) => s.kind === 'night');
    if (!night) return { ran: false, reason: 'no night today' };
    const pulses = steps.filter((s) => s.kind === 'pulse');
    const ranAt = (h: number) => pulses.some((p) => hourIn(ctx.tz, p.createdAt) >= h);
    const slots: Slot[] = hour >= 18 ? (ranAt(18) ? [] : ['evening']) : ranAt(12) ? [] : ['afternoon', 'evening'];
    if (!slots.length) return { ran: false, reason: 'already pulsed' };

    const last = steps[steps.length - 1]!;
    const [notes, thumbs] = await Promise.all([
        prisma.observation.findMany({ where: { userId, createdAt: { gt: last.createdAt } }, orderBy: { createdAt: 'desc' }, take: 30 }),
        prisma.buddyFeedback.findMany({ where: { userId, createdAt: { gt: last.createdAt } } }),
    ]);
    if (!notes.length && !thumbs.length) return { ran: false, reason: 'nothing new' };

    const state = await prisma.buddyState.findUnique({ where: { userId } });
    const signals = await buddySignals(userId, now);
    const current = (Array.isArray(last.lines) ? last.lines : []) as unknown as Line[];
    const said = steps.flatMap((s) => [...((Array.isArray(s.lines) ? s.lines : []) as unknown as Line[]).map((l) => `${l.slot}: ${l.text}`), ...(s.note ? [`note: ${s.note}`] : [])]);
    const text = [
        `<today>${signals.today.weekday} ${signals.today.day}, ${signals.today.time} (${ctx.tz}) · rewrite: ${slots.join(', ')}</today>`,
        `<signals>\n${JSON.stringify(signals)}\n</signals>`,
        `<right_now>${state?.now ?? 'not written yet'}</right_now>`,
        `<new>\n${notes.map((n) => `${n.kind} · ${n.sensitivity} · from ${n.source} · ${n.text}`).join('\n') || 'no new notes'}${thumbs.length ? `\nhis thumbs: ${thumbs.map((t) => `${t.target} ${t.verdict}`).join(', ')}` : ''}\n</new>`,
        `<said_today>\n${said.join('\n')}\n</said_today>`,
    ].join('\n\n');
    const request = {
        model: PULSE_MODEL,
        max_tokens: 4000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: PULSE_SCHEMA } },
        system: [{ type: 'text', text: `${characterPrompt({ name: state?.name ?? null, tone: state?.tone === 'gentle' ? 'gentle' : 'candid' })}\n\n${PULSE_JOB}`, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    } as CreateParams;
    let cost = 0;
    const message = await callClaude(withRefusalFallbacks(request), 'buddy pulse');
    cost += (await recordAiUsage(userId, 'buddy_pulse', message)).costUsd;
    const out = zPulse.parse(parseJson(responseText(message)));

    const sources = [JSON.stringify(signals), state?.now ?? '', ...notes.map((n) => n.text)].join('\n');
    const recent = said.map((s) => s.replace(/^[a-z]+: /, ''));
    const wanted = out.lines.filter((l) => slots.includes(l.slot));
    const guarded = guardLines(
        SLOTS.map((slot) => wanted.find((l) => l.slot === slot) ?? { slot, text: current.find((c) => c.slot === slot)?.text ?? '', form: 'plain' as const, lockOk: current.find((c) => c.slot === slot)?.lockOk ?? false, sourceId: '' }),
        { sources, recent: recent.filter((r) => !current.some((c) => c.text === r)), plain: plainLine(signals) }
    );
    // The hours gone keep their lines; a slot the pulse didn't rewrite keeps the night's.
    let lines: Line[] = SLOTS.map((slot) => (slots.includes(slot) && wanted.some((l) => l.slot === slot) ? guarded.lines.find((l) => l.slot === slot)! : current.find((c) => c.slot === slot) ?? guarded.lines.find((l) => l.slot === slot)!));
    const dropped = guarded.dropped.filter((d) => slots.some((s) => d.what.endsWith(s)));

    const noteText = unlabel(scrubSecrets(out.note).trim());
    const note = noteText && !strayNumbers(noteText, sources).length ? noteText.slice(0, 600) : null;
    // The lock check on the lines it wrote and its own note; a note carried over keeps its verdict.
    const privateTexts = (await prisma.memory.findMany({ where: { userId, status: 'active', sensitivity: 'private' }, select: { text: true }, take: 60 })).map((m) => m.text).concat(notes.filter((n) => n.sensitivity === 'private').map((n) => n.text));
    const checked = await lockCheck(userId, lines, privateTexts, note, dropped, slots);
    lines = checked.lines;
    cost += checked.costUsd;
    await prisma.buddyDay.create({
        data: {
            userId,
            day: toDbDay(ctx.today),
            kind: 'pulse',
            lines: lines as unknown as Prisma.InputJsonValue,
            note: note ?? last.note,
            noteLockOk: note ? checked.noteLockOk : last.noteLockOk,
            followUp: last.followUp,
            dropped: dropped as unknown as Prisma.InputJsonValue,
            model: message.model.slice(0, 100),
            costUsd: cost.toFixed(6),
            createdAt: now,
        },
    });
    await prisma.buddyState.update({ where: { userId }, data: { lastStepAt: now } });
    return { ran: true, reason: `${slots.join(' and ')}${note ? ' with a note' : ''}`, costUsd: Math.round(cost * 1e4) / 1e4 };
}

