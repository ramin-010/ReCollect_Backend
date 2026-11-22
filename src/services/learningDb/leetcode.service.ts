// LeetCode (11-22, the owner: "how would I track LeetCode that isn't in Recollect?"): their public LeetCode username;
// their newly accepted problems are logged as practice sessions, at most once in 20 hours (and at once on "Import
// now" or a new username). It reads LeetCode's public profile data (the GraphQL their own site uses): not an
// official API, so a change on their side can stop it; then the import says so and nothing else is touched.
//
//   GET  /api/leetcode            the username, when it last ran, how many sessions it logged
//   PUT  /api/leetcode {username} set (checked against LeetCode first) or clear (null); a new one imports at once
//   POST /api/leetcode/sync       import now
//
// A problem's session: kind practice, "LeetCode: Two Sum", its link, the day it was accepted (their zone), no minutes
// and no outcome (LeetCode doesn't say how long it took or whether hints were used), filed under their DSA subject
// when one is plain to see. The key `lc_<submission id>` makes each one land once.
import { prisma } from '../../db/prisma';
import { dayOf } from '../learning';
import { loadLearningContext, toDbDay } from './common';
import { badRequest } from '../learning/http';
import { poke } from '../scheduler/scheduler';

const ENDPOINT = 'https://leetcode.com/graphql';
/** The newest accepted submissions read per import (LeetCode's own limit is 20). */
export const LEETCODE_RECENT = 20;
/** An import runs at most this often by itself. */
export const LEETCODE_EVERY_MS = 20 * 3600_000;
/** Only what was accepted in the last 30 days comes in (a new username does not bring old history). */
const FIRST_IMPORT_DAYS = 30;
/** LeetCode usernames: letters, digits, _ and -, up to 40. */
export const LEETCODE_NAME = /^[A-Za-z0-9_-]{1,40}$/;

export interface LeetcodeSubmission {
    id: string;
    title: string;
    titleSlug: string;
    /** Seconds since the epoch, as LeetCode sends it. */
    timestamp: string;
}

/** What LeetCode is asked (injectable: tests never touch the network). */
export interface LeetcodeSource {
    exists(username: string): Promise<boolean>;
    recent(username: string): Promise<LeetcodeSubmission[]>;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', referer: 'https://leetcode.com/', 'user-agent': 'Mozilla/5.0 (compatible; Recollect)' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`LeetCode answered ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (!json.data) throw new Error(json.errors?.[0]?.message || 'LeetCode sent no data');
    return json.data;
}

const liveSource: LeetcodeSource = {
    async exists(username) {
        const data = await graphql<{ matchedUser: { username: string } | null }>('query user($username: String!) { matchedUser(username: $username) { username } }', { username });
        return !!data.matchedUser;
    },
    async recent(username) {
        const data = await graphql<{ recentAcSubmissionList: LeetcodeSubmission[] | null }>(
            'query recent($username: String!, $limit: Int!) { recentAcSubmissionList(username: $username, limit: $limit) { id title titleSlug timestamp } }',
            { username, limit: LEETCODE_RECENT }
        );
        return data.recentAcSubmissionList ?? [];
    },
};

let source: LeetcodeSource = liveSource;
/** Tests: a scripted LeetCode (null puts the live one back). */
export function setLeetcodeSourceForTests(s: LeetcodeSource | null): void {
    source = s ?? liveSource;
}

export interface LeetcodeJson {
    username: string | null;
    syncedAt: string | null;
    /** Practice sessions this import has logged in all. */
    logged: number;
}

const KEY_PREFIX = 'lc_';

export async function getLeetcode(userId: string): Promise<LeetcodeJson> {
    const [user, logged] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { leetcodeUser: true, leetcodeSyncedAt: true } }),
        prisma.workSession.count({ where: { userId, key: { startsWith: KEY_PREFIX } } }),
    ]);
    return { username: user.leetcodeUser, syncedAt: user.leetcodeSyncedAt?.toISOString() ?? null, logged };
}

/** The subject their LeetCode belongs to, when one is plain to see (DSA, algorithms, data structures, LeetCode). */
async function dsaSubject(userId: string): Promise<string | null> {
    const subjects = await prisma.subject.findMany({ where: { userId }, select: { id: true, name: true } });
    return subjects.find((s) => /\b(dsa|leetcode|algorithms?|data structures?)\b/i.test(s.name))?.id ?? null;
}

/** Import the newly accepted problems of the last 30 days (each once). */
export async function syncLeetcode(userId: string, now: Date = new Date()): Promise<{ logged: number; seen: number }> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { leetcodeUser: true } });
    if (!user.leetcodeUser) return { logged: 0, seen: 0 };
    const subs = await source.recent(user.leetcodeUser);
    const { tz } = await loadLearningContext(userId, now);
    const oldest = now.getTime() - FIRST_IMPORT_DAYS * 86_400_000;
    const keys = subs.map((s) => `${KEY_PREFIX}${s.id}`.slice(0, 80));
    const known = new Set((await prisma.workSession.findMany({ where: { userId, key: { in: keys } }, select: { key: true } })).map((r) => r.key));
    // One session a problem a day: a problem accepted twice the same day is one practice.
    const seenToday = new Set<string>();
    const subjectId = await dsaSubject(userId);
    let logged = 0;
    for (const s of [...subs].sort((a, b) => Number(a.timestamp) - Number(b.timestamp))) {
        const at = new Date(Number(s.timestamp) * 1000);
        if (!Number.isFinite(at.getTime()) || at.getTime() < oldest || at > now) continue;
        const key = `${KEY_PREFIX}${s.id}`.slice(0, 80);
        const day = dayOf(at, tz);
        const once = `${s.titleSlug}@${day}`;
        if (known.has(key) || seenToday.has(once)) continue;
        seenToday.add(once);
        const title = String(s.title || s.titleSlug).replace(/\s+/g, ' ').trim().slice(0, 180);
        const sameDay = await prisma.workSession.findFirst({ where: { userId, day: toDbDay(day), key: { startsWith: KEY_PREFIX }, problem: title }, select: { id: true } });
        if (sameDay) continue;
        await prisma.workSession.create({
            data: {
                userId,
                key,
                kind: 'practice',
                day: toDbDay(day),
                startedAt: at,
                title: `LeetCode: ${title}`,
                problem: title,
                url: `https://leetcode.com/problems/${encodeURIComponent(s.titleSlug)}/`,
                subjectId,
                source: 'user',
                agentName: 'LeetCode',
            },
            select: { id: true },
        });
        logged += 1;
    }
    await prisma.user.update({ where: { id: userId }, data: { leetcodeSyncedAt: now }, select: { id: true } });
    if (logged) poke('buddy'); // 11-22: what they did wakes the buddy's day
    return { logged, seen: subs.length };
}

/** PUT: a username checked against LeetCode (a new one imports at once), or null to stop. */
export async function setLeetcode(userId: string, username: string | null, now: Date = new Date()): Promise<LeetcodeJson & { imported?: number }> {
    if (username === null) {
        await prisma.user.update({ where: { id: userId }, data: { leetcodeUser: null, leetcodeSyncedAt: null }, select: { id: true } });
        return getLeetcode(userId);
    }
    const name = username.trim().replace(/^@/, '');
    if (!LEETCODE_NAME.test(name)) throw badRequest('A LeetCode username has only letters, digits, _ and -.');
    let found: boolean;
    try {
        found = await source.exists(name);
    } catch (err) {
        console.error(`[leetcode] check failed: ${err instanceof Error ? err.message : String(err)}`);
        throw badRequest('LeetCode didn’t answer just now. Try again in a minute.');
    }
    if (!found) throw badRequest(`LeetCode has no user “${name}”. It is the name in your profile’s link (leetcode.com/u/…).`);
    await prisma.user.update({ where: { id: userId }, data: { leetcodeUser: name }, select: { id: true } });
    let imported = 0;
    try {
        imported = (await syncLeetcode(userId, now)).logged;
    } catch (err) {
        console.error(`[leetcode] first import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ...(await getLeetcode(userId)), imported };
}

/** The pass: everyone with a username whose import is older than 20 hours (poll mode hourly; the quiet sweep). */
export async function runLeetcodePass(now: Date = new Date()): Promise<{ users: number; logged: number; failed: number }> {
    const due = await prisma.user.findMany({
        where: { leetcodeUser: { not: null }, OR: [{ leetcodeSyncedAt: null }, { leetcodeSyncedAt: { lt: new Date(now.getTime() - LEETCODE_EVERY_MS) } }] },
        select: { id: true },
        take: 200,
    });
    let logged = 0;
    let failed = 0;
    for (const u of due) {
        try {
            logged += (await syncLeetcode(u.id, now)).logged;
        } catch (err) {
            failed += 1;
            console.error(`[leetcode] import failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { users: due.length, logged, failed };
}
