// "Download everything" (ECOSYSTEM_V2_PLAN stage 11, §9.6 item 6): one JSON file with what this account keeps in
// Kaaga: its profile and settings, its docs as Markdown, tasks and reminders, the learning plan and record, Ask Kaaga's
// conversations, everything the buddy keeps (its own export), the AI it used and was given, the apps it connected
// and what it sent the owner. Never a secret: no password, no token or its hash, no Claude key, no sign-in codes, no
// push keys; nothing of anyone else's (a shared doc is exported by its owner).
//
//   GET /api/account/export   (cookie only)
import { prisma } from '../../db/prisma';
import { currentContent } from '../agent/agentDocs.service';
import { docJsonToMarkdown } from '../docs/markdown/docMarkdown';
import { exportBuddy } from '../buddy/memory.service';

/** Bump when the file's shape changes. */
export const EXPORT_VERSION = 1;

/** Drops the fields no export carries (internal ids of other people's rows are fine; secrets and raw bytes are not). */
function plain<T extends Record<string, unknown>>(row: T, drop: readonly string[] = []): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
        if (drop.includes(k) || v instanceof Uint8Array) continue;
        out[k] = v;
    }
    return out;
}

export async function exportAccount(userId: string, now: Date = new Date()) {
    const where = { userId };
    const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
            id: true,
            name: true,
            email: true,
            reminderEmail: true,
            phone: true,
            avatar: true,
            authProvider: true,
            timezone: true,
            dailyBudgetMin: true,
            nudgeEmailEnabled: true,
            nudgeTime: true,
            agentProfile: true,
            busyUntil: true,
            routineMode: true,
            globalStreak: true,
            longestGlobalStreak: true,
            plan: true,
            createdAt: true,
        },
    });
    const [docs, todos, reminders, subjects, topics, revisions, captures, goals, focus, pocket, weekTargets, decisions, sessions, projects, weakSpots, suggestions, history, threads, lockPins, routines, chapters, buddyReminders, aiSettings, grants, usage, tokens, feedback, buddy] =
        await Promise.all([
            prisma.doc.findMany({ where, orderBy: { createdAt: 'asc' }, select: { id: true, title: true, yjsState: true, isPinned: true, isArchived: true, trashedAt: true, publishedAt: true, createdAt: true, updatedAt: true, parentId: true, position: true } }),
            prisma.todo.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.reminder.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.subject.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.topic.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.revision.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.capture.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.goal.findMany({ where, orderBy: { createdAt: 'asc' }, include: { milestones: true } }),
            prisma.focusItem.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.quickNote.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.weekTarget.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.decision.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.workSession.findMany({ where, orderBy: { startedAt: 'asc' } }),
            prisma.project.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.weakSpot.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.suggestion.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.dailyHistory.findMany({ where, orderBy: { date: 'asc' } }),
            prisma.assistantThread.findMany({ where, orderBy: { createdAt: 'asc' }, include: { messages: { orderBy: { createdAt: 'asc' } } } }),
            prisma.lockPin.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.routine.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.buddyChapter.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.buddyReminder.findMany({ where, orderBy: { createdAt: 'asc' } }),
            prisma.aiSettings.findUnique({ where }),
            prisma.aiGrant.findMany({ where, orderBy: { createdAt: 'asc' }, select: { amountUsd: true, note: true, createdAt: true } }),
            prisma.$queryRaw<Array<{ month: string; feature: string; source: string; calls: number; usd: unknown }>>`
                SELECT to_char("createdAt", 'YYYY-MM') AS month, "feature"::text AS feature, "source", COUNT(*)::int AS calls, SUM("costUsd") AS usd
                FROM "AiUsage" WHERE "userId" = ${userId} GROUP BY 1, 2, 3 ORDER BY 1, 2`,
            prisma.apiToken.findMany({ where, orderBy: { createdAt: 'asc' }, select: { name: true, prefix: true, scopes: true, createdAt: true, lastUsedAt: true, revokedAt: true, expiresAt: true } }),
            prisma.feedback.findMany({ where, orderBy: { createdAt: 'asc' }, select: { kind: true, text: true, source: true, details: true, createdAt: true } }),
            exportBuddy(userId, now),
        ]);

    // DOC_PAGES_PLAN §5: a page block prints as its link line, with the title of any doc of theirs.
    const ownTitles = new Map(docs.map((d) => [d.id, d.title]));
    return {
        format: 'recollect-export',
        version: EXPORT_VERSION,
        exportedAt: now.toISOString(),
        account: user,
        docs: docs.map((d) => {
            const { json, title } = currentContent({ id: d.id, title: d.title, yjsState: d.yjsState }, { pageTitles: ownTitles });
            // DOC_PAGES_PLAN §3.2: where it sits in a tree (parentId null: a top-level doc).
            return { id: d.id, title, parentId: d.parentId, position: d.position, markdown: docJsonToMarkdown(json), pinned: d.isPinned, archived: d.isArchived, trashedAt: d.trashedAt, publishedAt: d.publishedAt, createdAt: d.createdAt, updatedAt: d.updatedAt };
        }),
        tasks: todos.map((t) => plain(t)),
        reminders: reminders.map((r) => plain(r)),
        learning: {
            subjects: subjects.map((r) => plain(r)),
            topics: topics.map((r) => plain(r)),
            revisions: revisions.map((r) => plain(r)),
            captures: captures.map((r) => plain(r)),
            goals: goals.map((r) => plain(r)),
            focus: focus.map((r) => plain(r)),
            pocket: pocket.map((r) => plain(r)),
            weekTargets: weekTargets.map((r) => plain(r)),
            decisions: decisions.map((r) => plain(r)),
            sessions: sessions.map((r) => plain(r)),
            projects: projects.map((r) => plain(r)),
            weakSpots: weakSpots.map((r) => plain(r)),
            suggestions: suggestions.map((r) => plain(r)),
            days: history.map((r) => plain(r)),
        },
        askAi: threads.map((t) => ({
            id: t.id,
            title: t.title,
            docId: t.docId,
            createdAt: t.createdAt,
            messages: t.messages.map((m) => ({ role: m.role, text: m.text, createdAt: m.createdAt })),
        })),
        buddy: { ...buddy, lockPins: lockPins.map((r) => plain(r)), routines: routines.map((r) => plain(r)), chapters: chapters.map((r) => plain(r)), reminders: buddyReminders.map((r) => plain(r)) },
        ai: {
            settings: aiSettings ? { monthlyCapUsd: aiSettings.monthlyCapUsd, dailyCapUsd: aiSettings.dailyCapUsd } : null,
            freeAiGiven: grants,
            usageByMonth: usage.map((u) => ({ month: u.month, feature: u.feature, paidBy: u.source === 'own' ? 'your key' : 'the server', calls: u.calls, usd: Number(u.usd ?? 0) })),
        },
        connectedApps: tokens,
        sentToOwner: feedback,
    };
}
