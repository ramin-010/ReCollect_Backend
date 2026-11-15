// Revise → Recollect import (LOOP_COMPLETE_SPEC S3). A dry run unless --apply.
//
//   npx ts-node --transpile-only scripts/import-revise.ts --to <email> [--revise-user <id>] [--apply] [--keep-secrets]
//
// Reads Revise's database (REVISE_DATABASE_URL, else DATABASE_URL in ../revise/.env; never printed)
// in one READ ONLY transaction: Postgres refuses any write in it, and the script only sends SELECTs.
// Revise stays untouched. What comes over and what is left out: src/services/import/reviseImport.ts
// (Ramin, 2026-11-14 night: the live database; topics not imported).
//
// --apply writes the plan into the account --to in one transaction and records each row in
// ImportedRow, so the next run (at the deploy) brings only what is new. Without --revise-user, the
// one Revise user with data is used; when there are several, they are listed and nothing happens.
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { Client, types } from 'pg';
import { prisma } from '../src/db/prisma';
import { applyReviseImport } from '../src/services/import/applyReviseImport';
import { dayFromUtcMidnight, resolveTimeZone, today } from '../src/services/learning/time';
import {
    IMPORT_SOURCE,
    planReviseImport,
    type ImportPlan,
    type ReviseAttachment,
    type ReviseCapture,
    type ReviseData,
    type ReviseQuickNote,
    type ReviseRevision,
    type ReviseSubject,
} from '../src/services/import/reviseImport';

const argValue = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
};

function reviseUrl(): string {
    if (process.env.REVISE_DATABASE_URL) return process.env.REVISE_DATABASE_URL;
    const file = path.resolve(__dirname, '..', '..', 'revise', '.env');
    const url = fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)).DATABASE_URL : undefined;
    if (!url) throw new Error('No Revise database: set REVISE_DATABASE_URL, or DATABASE_URL in revise/.env');
    return url;
}

// Prisma's DateTime columns are `timestamp` without a zone, holding UTC: read them as UTC (pg's
// default reads them in this PC's zone).
const utc = (text: string) => new Date(`${text.replace(' ', 'T')}Z`);
const pgTypes = { getTypeParser: (oid: number, format?: 'text' | 'binary') => (oid === 1114 ? utc : types.getTypeParser(oid, format as 'text')) };

interface ReviseUser {
    id: string;
    name: string | null;
    captures: number;
    quickNotes: number;
}

async function readRevise(reviseUserId: string | undefined): Promise<{ user: ReviseUser; data: ReviseData } | { users: ReviseUser[] }> {
    const client = new Client({ connectionString: reviseUrl(), types: pgTypes as never });
    await client.connect();
    try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '60s'");
        const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await client.query(sql, params)).rows as T[];
        const users = await q<ReviseUser>(`
            SELECT u."id", u."name",
                (SELECT count(*)::int FROM "Capture" c JOIN "Workspace" w ON w."id" = c."workspaceId" WHERE w."userId" = u."id") AS "captures",
                (SELECT count(*)::int FROM "QuickNote" n JOIN "Workspace" w ON w."id" = n."workspaceId" WHERE w."userId" = u."id") AS "quickNotes"
            FROM "User" u ORDER BY 3 DESC, 4 DESC`);
        const withData = users.filter((u) => u.captures + u.quickNotes > 0);
        const user = reviseUserId ? users.find((u) => u.id === reviseUserId) : withData.length === 1 ? withData[0] : undefined;
        if (!user) return { users };

        const ws = (await q<{ id: string }>(`SELECT "id" FROM "Workspace" WHERE "userId" = $1`, [user.id])).map((w) => w.id);
        const subjects = await q<ReviseSubject>(`SELECT "id", "name", "description", "icon", "color", "createdAt" FROM "Subject" WHERE "workspaceId" = ANY($1::text[])`, [ws]);
        const categories = await q<{ id: string; name: string }>(`SELECT "id", "name" FROM "NoteCategory" WHERE "workspaceId" = ANY($1::text[])`, [ws]);
        const captures = await q<ReviseCapture>(
            `SELECT "id", "type", "goalType", "title", "isPinned", "subjectId", "topicId", "categoryId", "content", "url", "cloudPublicId",
                    "fileType", "isDone", "completedAt", "dueDate", "time", "createdAt", "updatedAt"
             FROM "Capture" WHERE "workspaceId" = ANY($1::text[]) ORDER BY "createdAt", "id"`,
            [ws]
        );
        const ids = captures.map((c) => c.id);
        const attachments = await q<ReviseAttachment>(`SELECT "captureId", "url", "fileType", "fileName" FROM "Attachment" WHERE "captureId" = ANY($1::text[]) ORDER BY "createdAt"`, [ids]);
        const revisions = await q<ReviseRevision>(
            `SELECT "id", "captureId", "cycleNumber", "intervalDays", "scheduledFor", "completedAt", "status", "createdAt" FROM "Revision" WHERE "captureId" = ANY($1::text[])`,
            [ids]
        );
        const quickNotes = await q<ReviseQuickNote>(`SELECT "id", "content", "isPinned", "category", "attachments", "createdAt", "updatedAt" FROM "QuickNote" WHERE "workspaceId" = ANY($1::text[]) ORDER BY "createdAt"`, [ws]);
        const [reminders] = await q<{ total: number; ahead: number }>(
            `SELECT count(*)::int AS "total", count(*) FILTER (WHERE NOT "isDismissed" AND "remindAt" > now() AT TIME ZONE 'UTC')::int AS "ahead" FROM "Reminder" WHERE "captureId" = ANY($1::text[])`,
            [ids]
        );

        // What stays in Revise, counted for the report.
        const count = async (sql: string, params: unknown[]) => (await q<{ n: number }>(sql, params))[0]?.n ?? 0;
        const topicIds = (await q<{ id: string }>(`SELECT t."id" FROM "Topic" t JOIN "Subject" s ON s."id" = t."subjectId" WHERE s."workspaceId" = ANY($1::text[])`, [ws])).map((t) => t.id);
        const left: Record<string, number> = {
            topics: topicIds.length,
            'topic revisions': await count(`SELECT count(*)::int AS n FROM "Revision" WHERE "topicId" = ANY($1::text[])`, [topicIds]),
            'topic mentions': await count(`SELECT count(*)::int AS n FROM "TopicMention" WHERE "sourceTopicId" = ANY($1::text[])`, [topicIds]),
            'topic tags': await count(`SELECT count(*)::int AS n FROM "Tag" t JOIN "Subject" s ON s."id" = t."subjectId" WHERE s."workspaceId" = ANY($1::text[])`, [ws]),
            'time blocks': await count(`SELECT count(*)::int AS n FROM "TimeBlock" WHERE "workspaceId" = ANY($1::text[])`, [ws]),
            'daily slots': await count(`SELECT count(*)::int AS n FROM "DailyScheduleSlot" WHERE "workspaceId" = ANY($1::text[])`, [ws]),
            'block logs': await count(`SELECT count(*)::int AS n FROM "BlockSessionLog" l JOIN "TimeBlock" b ON b."id" = l."timeBlockId" WHERE b."workspaceId" = ANY($1::text[])`, [ws]),
            habits: await count(`SELECT count(*)::int AS n FROM "Habit" WHERE "workspaceId" = ANY($1::text[])`, [ws]),
            'day debriefs': await count(`SELECT count(*)::int AS n FROM "DayDebrief" WHERE "workspaceId" = ANY($1::text[])`, [ws]),
            'subject streaks': await count(`SELECT count(*)::int AS n FROM "SubjectStreak" WHERE "userId" = $1`, [user.id]),
            'daily history rows': await count(`SELECT count(*)::int AS n FROM "DailyHistory" WHERE "userId" = $1`, [user.id]),
            'activity log entries': await count(`SELECT count(*)::int AS n FROM "ActivityLog" WHERE "userId" = $1`, [user.id]),
        };
        return {
            user,
            data: { subjects, categories: new Map(categories.map((c) => [c.id, c.name])), captures, attachments, revisions, quickNotes, reminders: reminders ?? { total: 0, ahead: 0 }, left },
        };
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        await client.end();
    }
}

const quote = (s: string | null | undefined, max = 60) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
};

function report(plan: ImportPlan, source: ReviseData, userName: string, to: string, timezone: string, matched: string[]): void {
    const notes = plan.captures.filter((c) => c.data.type === 'NOTE');
    const links = plan.captures.filter((c) => c.data.type === 'LINK');
    const revisions = plan.captures.flatMap((c) => c.revisions);
    const todayDay = today(timezone);
    const pending = revisions.filter((r) => r.data.status === 'pending');
    const overdue = pending.filter((r) => dayFromUtcMidnight(r.data.scheduledFor) < todayDay).length;
    const dueToday = pending.filter((r) => dayFromUtcMidnight(r.data.scheduledFor) === todayDay).length;
    const open = plan.todos.filter((t) => t.data.status === 'pending');
    const goals = plan.todos.filter((t) => t.data.goalType !== 'NONE').length;
    const scratch = plan.quickNotes.filter((n) => n.data.category === 'TEMPORARY').length;
    const out: string[] = [];
    out.push(`Revise (read-only): ${userName}`);
    out.push(`Would bring into ${to}:`);
    out.push(`  notes        ${notes.length} (${notes.filter((n) => n.data.isPinned).length} pinned, ${notes.filter((n) => n.subject).length} in a subject)`);
    out.push(`  links        ${links.length}`);
    out.push(
        `  revisions    ${revisions.length} on ${plan.captures.filter((c) => c.revisions.length > 0).length} note(s) or link(s): ${revisions.filter((r) => r.data.status === 'done').length} done, ${pending.length} pending (${overdue} overdue, ${dueToday} due today)`
    );
    out.push(`  tasks        ${plan.todos.length} (${open.length} open, ${plan.todos.length - open.length} done; ${goals} weekly or monthly goals)`);
    out.push(`  quick notes  ${plan.quickNotes.length} (${plan.quickNotes.length - scratch} Vault, ${scratch} Scratch)`);
    out.push(
        `  subjects     ${plan.subjectsToMake.length} to make${plan.subjectsToMake.length ? `: ${plan.subjectsToMake.map((s) => quote(s.data.name, 40)).join(', ')}` : ''}${matched.length ? `; ${matched.length} matched by name: ${matched.map((m) => quote(m, 40)).join(', ')}` : ''}`
    );
    const before = plan.already.captures + plan.already.todos + plan.already.quickNotes;
    out.push(`Brought by an earlier run (left as they are): ${before ? `${plan.already.captures} notes and links, ${plan.already.todos} tasks, ${plan.already.quickNotes} quick notes` : 'none'}`);
    const left = Object.entries(source.left).filter(([, n]) => n > 0);
    out.push(`Staying in Revise: ${left.length ? left.map(([k, n]) => `${n} ${k}`).join(', ') : 'nothing else'}`);
    for (const line of plan.notes) out.push(`Note: ${line}`);
    out.push('A few of each:');
    out.push(`  notes:       ${notes.slice(0, 3).map((n) => quote(n.data.title ?? n.data.content)).join(', ') || '-'}`);
    out.push(`  links:       ${links.slice(0, 3).map((n) => quote(n.data.title ?? n.data.url)).join(', ') || '-'}`);
    out.push(`  tasks:       ${plan.todos.slice(0, 3).map((t) => quote(t.data.title)).join(', ') || '-'}`);
    out.push(`  quick notes: ${plan.quickNotes.slice(0, 3).map((n) => quote(n.data.content)).join(', ') || '-'}`);
    console.log(out.join('\n'));
}

async function main(): Promise<void> {
    const to = argValue('--to');
    if (!to) throw new Error('Name the Recollect account to import into: --to <email>');
    const target = await prisma.user.findUnique({ where: { email: to }, select: { id: true, timezone: true } });
    if (!target) throw new Error(`No Recollect account ${to}`);

    const read = await readRevise(argValue('--revise-user'));
    if ('users' in read) {
        console.log('Revise has more than one user with data (or none matches --revise-user). Pick one with --revise-user <id>:');
        for (const u of read.users) console.log(`  ${u.id}  ${u.name ?? '(no name)'}: ${u.captures} captures, ${u.quickNotes} quick notes`);
        return;
    }
    const timezone = resolveTimeZone(target.timezone);
    const subjects = await prisma.subject.findMany({ where: { userId: target.id }, select: { id: true, name: true } });
    const subjectsByName = new Map(subjects.map((s) => [s.name.trim().replace(/\s+/g, ' ').toLowerCase(), s.id]));
    const imported = await prisma.importedRow.findMany({ where: { userId: target.id, source: IMPORT_SOURCE }, select: { sourceTable: true, sourceId: true } });
    const plan = planReviseImport(
        read.data,
        { timezone, subjectsByName, imported: new Set(imported.map((r) => `${r.sourceTable}:${r.sourceId}`)) },
        { keepSecrets: process.argv.includes('--keep-secrets') }
    );
    const referenced = new Set(plan.captures.flatMap((c) => (c.subject && 'existing' in c.subject ? [c.subject.existing] : [])));
    const matched = subjects.filter((s) => referenced.has(s.id)).map((s) => s.name);
    report(plan, read.data, read.user.name ?? '(no name)', to, timezone, matched);

    if (!process.argv.includes('--apply')) {
        console.log('\nNothing was written (a dry run). Run again with --apply to import.');
        return;
    }
    const done = await applyReviseImport(plan, target.id);
    console.log(`\nImported into ${to}: ${done.subjects} subjects, ${done.captures} notes and links (${done.revisions} revisions), ${done.todos} tasks, ${done.quickNotes} quick notes.`);
}

main()
    .catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
