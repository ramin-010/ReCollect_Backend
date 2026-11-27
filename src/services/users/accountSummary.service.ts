// Settings › Your data (TRUST_PLAN T3, 11-27): what Kaaga keeps for an account, counted by kind, and who can see it
// (the docs shared or published, the agents and apps connected, and whether this account runs the server). Read live;
// the counts include everything kept (memories in every state, tasks done or not), as the export does.
//
//   GET /api/account/summary   (cookie only)
import { prisma } from '../../db/prisma';
import { isOwnerAccount } from '../claude/allowance';

export type KeepKind = 'docs' | 'notes' | 'pocket' | 'tasks' | 'reminders' | 'goals' | 'subjects' | 'memories' | 'conversations' | 'sessions' | 'files';

export interface AccountSummaryJson {
    keeps: Array<{ kind: KeepKind; count: number }>;
    shares: { docs: Array<{ id: string; title: string; people: number; published: boolean }>; shared: number; people: number; published: number };
    agents: Array<{ id: string; name: string; lastUsedAt: string | null; createdAt: string }>;
    isOwner: boolean;
}

export async function accountSummary(userId: string, now: Date = new Date()): Promise<AccountSummaryJson> {
    const where = { userId };
    const sharedWhere = { userId, trashedAt: null, collaborators: { some: {} } };
    const [docs, notes, pocket, tasks, reminders, buddyReminders, goals, subjects, memories, conversations, sessions, files, shared, published, sharedDocs, people, agents, isOwner] = await Promise.all([
        prisma.doc.count({ where: { userId, trashedAt: null } }),
        prisma.capture.count({ where }),
        prisma.quickNote.count({ where }),
        prisma.todo.count({ where }),
        prisma.reminder.count({ where }),
        prisma.buddyReminder.count({ where }),
        prisma.goal.count({ where }),
        prisma.subject.count({ where }),
        prisma.memory.count({ where }),
        prisma.assistantThread.count({ where }),
        prisma.workSession.count({ where }),
        // Files: those on notes and pocket notes (their attachments) and those a doc lists (its images and File blocks).
        prisma.$queryRaw<Array<{ n: number }>>`
            SELECT (
                (SELECT COALESCE(SUM(jsonb_array_length("attachments")), 0) FROM "Capture" WHERE "userId" = ${userId} AND jsonb_typeof("attachments") = 'array')
              + (SELECT COALESCE(SUM(jsonb_array_length("attachments")), 0) FROM "QuickNote" WHERE "userId" = ${userId} AND jsonb_typeof("attachments") = 'array')
              + (SELECT COALESCE(SUM(jsonb_array_length("cloudImages")), 0) FROM "Doc" WHERE "userId" = ${userId} AND jsonb_typeof("cloudImages") = 'array')
            )::int AS n`,
        prisma.doc.count({ where: sharedWhere }),
        prisma.doc.count({ where: { userId, trashedAt: null, publishedAt: { not: null } } }),
        prisma.doc.findMany({
            where: { userId, trashedAt: null, OR: [{ collaborators: { some: {} } }, { publishedAt: { not: null } }] },
            orderBy: { updatedAt: 'desc' },
            take: 10,
            select: { id: true, title: true, publishedAt: true, _count: { select: { collaborators: true } } },
        }),
        prisma.docCollaborator.findMany({ where: { doc: sharedWhere }, distinct: ['userId'], select: { userId: true } }),
        prisma.apiToken.findMany({
            where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
            select: { id: true, name: true, lastUsedAt: true, createdAt: true },
        }),
        isOwnerAccount(userId),
    ]);
    return {
        keeps: [
            { kind: 'docs', count: docs },
            { kind: 'notes', count: notes },
            { kind: 'pocket', count: pocket },
            { kind: 'tasks', count: tasks },
            { kind: 'reminders', count: reminders + buddyReminders },
            { kind: 'goals', count: goals },
            { kind: 'subjects', count: subjects },
            { kind: 'memories', count: memories },
            { kind: 'conversations', count: conversations },
            { kind: 'sessions', count: sessions },
            { kind: 'files', count: Number(files[0]?.n ?? 0) },
        ],
        shares: {
            docs: sharedDocs.map((d) => ({ id: d.id, title: d.title, people: d._count.collaborators, published: !!d.publishedAt })),
            shared,
            people: people.length,
            published,
        },
        agents: agents.map((a) => ({ id: a.id, name: a.name, lastUsedAt: a.lastUsedAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString() })),
        isOwner,
    };
}
