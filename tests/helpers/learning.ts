// Learning fixtures for integration tests: rows written straight to Postgres (days as UTC-midnight
// dates, like the services do) plus a pg spy that records every SQL statement.
import pg from 'pg';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { addDays, dayToUtcMidnight, REVISION_INTERVALS } from '../../src/services/learning';
import { authCookie, createTestUser } from './auth';

export const d = dayToUtcMidnight;

/** A user with a learning time zone (default Asia/Kolkata). */
export async function createLearner(timezone = 'Asia/Kolkata', extra: Record<string, unknown> = {}) {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { timezone, ...extra } });
    return user;
}

export const api = (user: { id: string }) => ({
    get: (url: string) => request(app).get(url).set('Cookie', authCookie(user)),
    post: (url: string, body?: object) => request(app).post(url).set('Cookie', authCookie(user)).send(body ?? {}),
    put: (url: string, body?: object) => request(app).put(url).set('Cookie', authCookie(user)).send(body ?? {}),
    patch: (url: string, body?: object) => request(app).patch(url).set('Cookie', authCookie(user)).send(body ?? {}),
    delete: (url: string) => request(app).delete(url).set('Cookie', authCookie(user)),
});

export async function createSubjectRow(userId: string, name = 'DSA') {
    return prisma.subject.create({ data: { userId, name, color: '#007acc' } });
}

/** A doc + a topic on it. */
export async function createTopicRow(userId: string, subjectId: string, title = 'Binary search') {
    const doc = await prisma.doc.create({ data: { userId, title } });
    const topic = await prisma.topic.create({ data: { userId, subjectId, docId: doc.id, title } });
    return { doc, topic };
}

/**
 * The 4 revisions of an item as if started on `startDay` (+1/+3/+7/+21). Overrides per cycle:
 * { 1: { status: 'done', completedAt } }.
 */
export async function createChainRows(
    userId: string,
    item: { topicId: string } | { captureId: string },
    startDay: string,
    overrides: Record<number, { status?: 'pending' | 'done'; completedAt?: Date | null; scheduledFor?: string }> = {}
) {
    const rows = [];
    for (const [i, interval] of REVISION_INTERVALS.entries()) {
        const cycle = i + 1;
        const o = overrides[cycle] ?? {};
        rows.push(
            await prisma.revision.create({
                data: {
                    userId,
                    topicId: 'topicId' in item ? item.topicId : null,
                    captureId: 'captureId' in item ? item.captureId : null,
                    cycleNumber: cycle,
                    intervalDays: interval,
                    scheduledFor: d(o.scheduledFor ?? addDays(startDay, interval)),
                    status: o.status ?? 'pending',
                    completedAt: o.completedAt ?? null,
                },
            })
        );
    }
    return rows;
}

export async function chainDays(where: { topicId: string } | { captureId: string }) {
    const rows = await prisma.revision.findMany({ where, orderBy: { cycleNumber: 'asc' } });
    return rows.map((r) => `${r.cycleNumber}:${r.scheduledFor.toISOString().slice(0, 10)}:${r.status}`);
}

/** Records every SQL statement sent through pg while `fn` runs. */
export async function recordSql<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
    const proto = (pg as any).Client.prototype;
    const original = proto.query;
    const sql: string[] = [];
    proto.query = function spy(this: unknown, ...args: any[]) {
        const q = args[0];
        sql.push(String(typeof q === 'string' ? q : q?.text ?? ''));
        return original.apply(this, args);
    };
    try {
        return { result: await fn(), sql };
    } finally {
        proto.query = original;
    }
}
