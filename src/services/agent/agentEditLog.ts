// The agent edit log (AgentEdit): one row per agent write, for Home's "From your agent" (Open /
// Keep / Undo) and for Undo itself. Writing rows lives here; listing and undoing are in
// ./agentEdits.service.ts.
import type { Request } from 'express';
import type { AgentEdit, AgentEditKind, Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { agentNameFor, requireUser } from '../../middlwares/auth';

/** Who made an agent write. */
export interface AgentActor {
    userId: string;
    agentName: string;
    /** The access token used; null for a cookie session (someone calling the agent API from the app). */
    tokenId: string | null;
}

/** The actor of an authenticated request (a cookie session is "You" unless X-Agent-Name says otherwise). */
export function agentActor(req: Request): AgentActor {
    const user = requireUser(req);
    const auth = req.auth;
    if (auth?.via === 'token') return { userId: user.id, agentName: auth.agentName, tokenId: auth.tokenId };
    return { userId: user.id, agentName: agentNameFor(req.headers['x-agent-name'], 'You'), tokenId: null };
}

/** `"Some title"`, cut to `max` characters. */
export function quoted(text: string, max = 60): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return `"${clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean}"`;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export interface AgentEditInput {
    kind: AgentEditKind;
    summary: string;
    docId?: string | null | undefined;
    entityId?: string | null | undefined;
    snapshotId?: string | null | undefined;
    undoData?: Prisma.InputJsonValue | undefined;
}

const SUMMARY_MAX = 300;

/** Log one agent write; returns the edit id. */
export async function recordAgentEdit(actor: AgentActor, input: AgentEditInput, db: DbClient = prisma): Promise<string> {
    const row = await db.agentEdit.create({
        data: {
            userId: actor.userId,
            tokenId: actor.tokenId,
            agentName: actor.agentName,
            kind: input.kind,
            summary: input.summary.length > SUMMARY_MAX ? `${input.summary.slice(0, SUMMARY_MAX - 1)}…` : input.summary,
            docId: input.docId ?? null,
            entityId: input.entityId ?? null,
            snapshotId: input.snapshotId ?? null,
            ...(input.undoData !== undefined ? { undoData: input.undoData } : {}),
        },
        select: { id: true },
    });
    return row.id;
}

const DOC_CHANGE_KINDS: ReadonlySet<AgentEditKind> = new Set(['doc_append', 'doc_replace_section', 'doc_canvas_update']);

/** Undo is offered until it is used; doc changes need their snapshot. */
export function canUndo(edit: Pick<AgentEdit, 'kind' | 'undoneAt' | 'snapshotId'>): boolean {
    if (edit.undoneAt) return false;
    return DOC_CHANGE_KINDS.has(edit.kind) ? edit.snapshotId !== null : true;
}

export function isDocChange(kind: AgentEditKind): boolean {
    return DOC_CHANGE_KINDS.has(kind);
}

/** GET /api/agent/edits item. */
export function serializeAgentEdit(edit: AgentEdit) {
    return {
        id: edit.id,
        kind: edit.kind,
        agentName: edit.agentName,
        summary: edit.summary,
        docId: edit.docId,
        entityId: edit.entityId,
        createdAt: edit.createdAt,
        seenAt: edit.seenAt,
        undoneAt: edit.undoneAt,
        canUndo: canUndo(edit),
    };
}

export type AgentEditJson = ReturnType<typeof serializeAgentEdit>;
