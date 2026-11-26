// Actions that need the user's tap (MANAGER_AND_DOCS_PLAN §3.2, level 3): whatever leaves the app or
// can't be undone. An agent or the manager asks (POST /api/actions); the action is checked now and
// kept as a pending Suggestion of kind `action` holding the exact call; Home's Suggested shows it
// with "Do it" and Dismiss, and only his tap (accepting it, cookie only) runs it. A level-3 tool
// therefore can't act by itself, whatever a doc or a page it read told the model.
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { addDays, type DayString } from '../learning';
import { badRequest, conflict } from '../learning/http';
import { loadLearningContext, toDbDay } from '../learningDb/common';
import { emptyTrash, trashedDocs } from '../docs/trash.service';
import { freshStart, type FreshStartResult } from '../learningDb/plan.service';
import { describeShareAction, runShareAction } from '../docs/docSharing.service';

/** Pending actions a caller may have waiting at once. */
export const ACTIONS_PENDING_MAX = 10;
/** A pending action is offered for a week. */
const ACTION_DAYS = 7;

interface ActionDef<I> {
    input: z.ZodType<I>;
    /** The card's words: exactly what "Do it" will do. Throws when there is nothing to do. */
    describe(userId: string, input: I): Promise<string>;
    /** Runs it on his tap; says what happened. */
    run(userId: string, input: I): Promise<string>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const ACTIONS = {
    empty_trash: {
        input: z.object({}).strict(),
        async describe(userId: string) {
            const docs = await trashedDocs(userId);
            if (docs.length === 0) throw badRequest('The trash is empty', 'NOTHING_TO_DO');
            const names = docs.slice(0, 3).map((d) => `"${d.title || 'Untitled'}"`).join(', ');
            return `Empty the trash: delete ${plural(docs.length, 'doc')} for good (${names}${docs.length > 3 ? ', …' : ''})`;
        },
        async run(userId: string) {
            const { deleted } = await emptyTrash(userId);
            return `Deleted ${plural(deleted, 'doc')} for good`;
        },
    } satisfies ActionDef<Record<string, never>>,
    // More than SPREAD_TAP_OVER overdue reviews moved in one go needs his tap (§3.2: "more than 20").
    spread_backlog: {
        input: z.object({}).strict(),
        async describe(userId: string) {
            const dry = await freshStart(userId, { dryRun: true });
            if (dry.moved === 0) throw badRequest('Nothing is overdue', 'NOTHING_TO_DO');
            return `Spread ${plural(dry.moved, 'overdue review')} over the next ${plural(dry.spreadDays, 'day')}, as your daily budget allows`;
        },
        async run(userId: string) {
            const r = await freshStart(userId);
            return r.moved ? `Moved ${plural(r.moved, 'review')} over ${plural(r.spreadDays, 'day')}` : 'Nothing was overdue any more';
        },
    } satisfies ActionDef<Record<string, never>>,
    // Sharing leaves the app (MANAGER_AND_DOCS_PLAN §2): publishing, unpublishing (its link dies) and
    // adding, changing or removing a person each wait for his tap.
    publish_doc: {
        input: z.object({ docId: z.string().trim().min(1).max(64), on: z.boolean() }).strict(),
        describe: (userId: string, input: { docId: string; on: boolean }) => describeShareAction(userId, { kind: 'publish', ...input }),
        run: (userId: string, input: { docId: string; on: boolean }) => runShareAction(userId, { kind: 'publish', ...input }),
    } satisfies ActionDef<{ docId: string; on: boolean }>,
    share_doc: {
        input: z
            .object({ docId: z.string().trim().min(1).max(64), email: z.string().trim().email().max(200), role: z.enum(['viewer', 'editor', 'remove']) })
            .strict(),
        describe: (userId: string, input: ShareDocInput) => describeShareAction(userId, { kind: 'person', ...input }),
        run: (userId: string, input: ShareDocInput) => runShareAction(userId, { kind: 'person', ...input }),
    } satisfies ActionDef<ShareDocInput>,
} as const;

type ShareDocInput = { docId: string; email: string; role: 'viewer' | 'editor' | 'remove' };

/** An agent spreads at most this many overdue reviews at once; more only asks (his tap). */
export const SPREAD_TAP_OVER = 20;

/**
 * POST /api/revisions/spread (an agent or the manager): every overdue review spread over today and
 * the next days by his budget, at once and undoable; when that is more than SPREAD_TAP_OVER, it
 * only asks (the spread_backlog action).
 */
export async function spreadBacklog(
    userId: string,
    agentName: string,
    reason: string | null | undefined,
    now: Date = new Date()
): Promise<FreshStartResult & { asked: boolean; card: { _id: string; text: string } | null }> {
    const dry = await freshStart(userId, { dryRun: true }, now);
    if (dry.moved === 0) return { ...dry, asked: false, card: null };
    if (dry.moved > SPREAD_TAP_OVER) {
        const card = await requestAction(userId, agentName, { action: 'spread_backlog', reason }, now);
        return { moved: dry.moved, spreadDays: dry.spreadDays, changes: [], asked: true, card: { _id: card.id, text: card.text } };
    }
    return { ...(await freshStart(userId, {}, now)), asked: false, card: null };
}

export type ActionName = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[];

const isActionName = (name: unknown): name is ActionName => typeof name === 'string' && name in ACTIONS;

function parseInput(action: ActionName, input: unknown): unknown {
    const parsed = (ACTIONS[action].input as z.ZodType).safeParse(input ?? {});
    if (!parsed.success) throw badRequest(`Bad input for ${action}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
    return parsed.data;
}

export interface ActionRequest {
    action: string;
    input?: unknown;
    reason?: string | null | undefined;
}

/**
 * POST /api/actions: checks the action and its input now, then keeps it as a pending suggestion
 * of kind `action` (nothing happens until the user taps "Do it"). The answer is the pending card.
 */
export async function requestAction(userId: string, agentName: string, body: ActionRequest, now: Date = new Date()) {
    if (!isActionName(body.action)) throw badRequest(`No action "${body.action}". Actions: ${ACTION_NAMES.join(', ')}`, 'UNKNOWN_ACTION');
    const input = parseInput(body.action, body.input);
    const text = (await (ACTIONS[body.action] as ActionDef<unknown>).describe(userId, input)).slice(0, 200);
    // The same action already waiting (asked again): one card, its words brought up to date.
    const same = await prisma.suggestion.findFirst({
        where: { userId, kind: 'action', status: 'pending', payload: { path: ['action'], equals: body.action } },
        orderBy: { createdAt: 'desc' },
    });
    if (same && JSON.stringify((same.payload as { input?: unknown }).input ?? {}) === JSON.stringify(input ?? {})) {
        return prisma.suggestion.update({ where: { id: same.id }, data: { text, reason: body.reason ? body.reason.slice(0, 200) : same.reason } });
    }
    const waiting = await prisma.suggestion.count({ where: { userId, kind: 'action', status: 'pending', agentName } });
    if (waiting >= ACTIONS_PENDING_MAX) throw conflict(`${ACTIONS_PENDING_MAX} of your actions are still waiting for the user's tap`, 'ACTION_LIMIT');
    const ctx = await loadLearningContext(userId, now);
    const expires: DayString = addDays(ctx.today, ACTION_DAYS);
    return prisma.suggestion.create({
        data: {
            userId,
            kind: 'action',
            text,
            reason: body.reason ? body.reason.slice(0, 200) : null,
            payload: { action: body.action, input } as Prisma.InputJsonValue,
            proposedBy: isAskAiAgent(agentName) ? 'ask_ai' : 'agent',
            agentName,
            expiresDay: toDbDay(expires),
        },
    });
}

/** The manager's agent name (its writes and actions carry it): Ask Kaaga since 11-26 (KAAGA_REBRAND_PLAN). */
export const ASK_AI_AGENT = 'Ask Kaaga';
/** Its names, old and new: writes made before the rename still count as the manager's. */
export const ASK_AI_AGENTS: readonly string[] = [ASK_AI_AGENT, 'Ask AI'];
export const isAskAiAgent = (name: string | null | undefined): boolean => !!name && ASK_AI_AGENTS.includes(name);

/** Accepting an action suggestion (his tap): run the call it holds, checked again. */
export async function runAction(userId: string, payload: Record<string, unknown>): Promise<string> {
    const action = payload['action'];
    if (!isActionName(action)) throw badRequest('This action is not known any more', 'UNKNOWN_ACTION');
    const input = parseInput(action, payload['input']);
    return (ACTIONS[action] as ActionDef<unknown>).run(userId, input);
}
