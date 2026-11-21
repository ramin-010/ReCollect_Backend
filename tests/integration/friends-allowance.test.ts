// Stage 11 of ECOSYSTEM_V2_PLAN, the owner's decision 1 (11-20): invites and free AI for invited friends, on scripted
// models. Signup stays closed and an invite lets its email in once; its $5 becomes the first grant; the server's key
// serves a friend while the allowance lasts, $1 a day and the friends' ceiling; at $0 the calm 503 (AI_PAUSED), the
// buddy waits and a hook holds; a top-up lets it go on; another person's grant is never used; the ceiling never stops
// the owner; their own key spends nothing of it; only the owner reaches the People page; ending access stops sign-in
// and every request; feedback and the phone's diagnostics reach the owner.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { callClaude, setAiClientForTests } from '../../src/services/claude/client';
import { aiAccessFor } from '../../src/services/claude/access';
import { allowanceOf, CEILING_SETTING, forgetOwnerForTests, friendsMonthSpend } from '../../src/services/claude/allowance';
import { buddyMaySpend } from '../../src/services/buddy/spend';
import { recordAiUsage } from '../../src/services/claude/usage.service';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser, authCookie, TEST_PASSWORD } from '../helpers/auth';
import { api } from '../helpers/learning';
import { clearSentMails, lastOtpSentTo } from '../helpers/mail';

const fake = new FakeClaude();
const env = { ...process.env };
let owner: Awaited<ReturnType<typeof createTestUser>>;
const stamp = Date.now();
const mail = (who: string) => `${who}-${stamp}@friends.test`;

beforeAll(async () => {
    owner = await createTestUser({ email: mail('owner') });
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    process.env.OWNER_EMAIL = owner.email;
    process.env.SIGNUP_MODE = 'closed';
    process.env.AI_ALLOWED_EMAILS = owner.email;
    forgetOwnerForTests();
    setAiClientForTests(fake);
});
afterAll(async () => {
    await prisma.serverSetting.deleteMany({ where: { key: CEILING_SETTING } });
    for (const k of ['CLAUDE_API_KEY', 'OWNER_EMAIL', 'SIGNUP_MODE', 'AI_ALLOWED_EMAILS'] as const) {
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
    }
    forgetOwnerForTests();
    setAiClientForTests(null);
});
beforeEach(() => {
    fake.reset();
    clearSentMails();
});

const ask = (userId: string) => callClaude(userId, { model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } as never, 'a test');
/** Spend on the server's key as if calls had run (the meter's rows). */
const spend = (userId: string, usd: number, at = new Date(), source = 'house') =>
    prisma.aiUsage.create({ data: { userId, feature: 'assistant', model: 'claude-sonnet-5-5', costUsd: usd.toFixed(6), source, createdAt: at } });

async function invite(email: string, allowanceUsd?: number) {
    const r = await api(owner).post('/api/owner/people', { email, name: 'Asha Friend', ...(allowanceUsd !== undefined ? { allowanceUsd } : {}) });
    expect(r.status).toBe(201);
    expect(r.body.data.kind).toBe('invite');
    return r.body.data.invite as { id: string; link: string };
}
const codeOf = (link: string) => new URL(link).searchParams.get('invite')!;

/** The email-code signup, as the signup page does it. */
async function signUp(email: string) {
    const pre = await request(app).post('/api/pre-signup').send({ name: 'Asha', email, password: 'asha-secret-1' });
    if (pre.status !== 200) return pre;
    return request(app).post('/api/verify-signup').send({ email, otp: lastOtpSentTo(email) });
}

describe('invites (stage 11)', () => {
    it('signup closed: only an invited email gets in, once; the invite gives $5 and starts the buddy with the loop on', async () => {
        expect((await signUp(mail('stranger'))).status).toBe(403);
        const link = (await invite(mail('asha'))).link;
        expect(link).toMatch(/\/signup\?invite=[A-Za-z0-9_-]{24}$/);

        // The signup page reads the invite without a login.
        const view = await request(app).get(`/api/invites/${codeOf(link)}`);
        expect(view.body.data).toMatchObject({ email: mail('asha'), name: 'Asha Friend', allowanceUsd: 5, state: 'open' });
        expect((await request(app).get('/api/invites/not-a-real-code-at-all')).status).toBe(404);

        const made = await signUp(mail('asha'));
        expect(made.status).toBe(201);
        const asha = await prisma.user.findUniqueOrThrow({ where: { email: mail('asha') } });
        const grants = await prisma.aiGrant.findMany({ where: { userId: asha.id } });
        expect(grants.map((g) => [Number(g.amountUsd), g.givenById, g.note])).toEqual([[5, owner.id, 'Invite']]);
        expect(await prisma.buddyState.findUnique({ where: { userId: asha.id } })).toMatchObject({ enabled: true, loop: true });
        expect((await request(app).get(`/api/invites/${codeOf(link)}`)).body.data.state).toBe('used');
        // Used: it never lets anyone in again (the account exists; a second invite use gives nothing).
        expect(await prisma.aiGrant.count({ where: { userId: asha.id } })).toBe(1);
    });

    it('a revoked or expired invite is refused; the password route needs the link’s code (it proves no address)', async () => {
        const revoked = await invite(mail('rev'));
        expect((await api(owner).delete(`/api/owner/invites/${revoked.id}`)).body.data).toEqual({ revoked: true });
        expect((await signUp(mail('rev'))).status).toBe(403);

        const old = await invite(mail('old'));
        await prisma.signupInvite.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expect((await signUp(mail('old'))).status).toBe(403);

        const pw = await invite(mail('pw'));
        const base = { name: 'Pat', email: mail('pw'), password: 'pat-secret-12' };
        expect((await request(app).post('/api/signup').send(base)).status).toBe(403);
        expect((await request(app).post('/api/signup').send({ ...base, invite: 'x'.repeat(24) })).status).toBe(403);
        const ok = await request(app).post('/api/signup').send({ ...base, invite: codeOf(pw.link) });
        expect(ok.status).toBe(200);
        expect(await prisma.aiGrant.count({ where: { user: { email: mail('pw') } } })).toBe(1);
    });

    it('adding a person who has an account gives the allowance at once; a second invite for one email revokes the first', async () => {
        const kim = await createTestUser({ email: mail('kim') });
        const r = await api(owner).post('/api/owner/people', { email: kim.email.toUpperCase(), name: 'Kim', allowanceUsd: 3 });
        expect(r.body.data).toMatchObject({ kind: 'granted', personId: kim.id });
        expect((await allowanceOf(kim.id))?.grantedUsd).toBe(3);

        const first = await invite(mail('twice'));
        await invite(mail('twice'));
        expect((await request(app).get(`/api/invites/${codeOf(first.link)}`)).body.data.state).toBe('revoked');
    });
});

describe('the People page is the owner’s only', () => {
    it('refuses anyone else, an agent token, and everyone while OWNER_EMAIL is unset', async () => {
        const someone = await createTestUser();
        expect((await api(someone).get('/api/owner/people')).status).toBe(403);
        expect((await api(someone).get('/api/owner/check')).body.data).toEqual({ owner: false });
        expect((await api(owner).get('/api/owner/check')).body.data).toEqual({ owner: true });
        const page = await api(owner).get('/api/owner/people');
        expect(page.status).toBe(200);
        expect(page.body.data.people.find((p: { id: string }) => p.id === owner.id)).toMatchObject({ isOwner: true, ai: 'list', allowance: null });
        expect((await api(someone).post('/api/owner/people', { email: mail('nope') })).status).toBe(403);
        const saved = process.env.OWNER_EMAIL;
        delete process.env.OWNER_EMAIL;
        forgetOwnerForTests();
        try {
            expect((await api(owner).get('/api/owner/people')).status).toBe(403);
        } finally {
            process.env.OWNER_EMAIL = saved;
            forgetOwnerForTests();
        }
    });
});

describe('the free allowance (stage 11)', () => {
    async function friend(allowanceUsd = 5) {
        const u = await createTestUser();
        await api(owner).post('/api/owner/people', { email: u.email, name: u.name, allowanceUsd });
        await prisma.buddyState.create({ data: { userId: u.id, enabled: true, loop: true } });
        return u;
    }

    it('the server’s key serves a friend while it lasts (no place on the list needed); at $0 the calm 503; a top-up lets it go on', async () => {
        const f = await friend(5);
        // Its limit a day out of the way here (the next case holds it): the owner's "Set budget".
        await api(owner).patch(`/api/owner/people/${f.id}`, { dailyCapUsd: 20 });
        fake.push(fakeMessage('hello'));
        const message = await ask(f.id);
        await recordAiUsage(f.id, 'assistant', message);
        expect(await prisma.aiUsage.findFirst({ where: { userId: f.id }, select: { source: true } })).toEqual({ source: 'house' });

        await spend(f.id, 4.99);
        expect((await aiAccessFor(f.id)).state).toBe('allowance');
        expect((await aiAccessFor(f.id)).allowance).toMatchObject({ grantedUsd: 5, leftUsd: 0, reason: 'empty' });
        await expect(ask(f.id)).rejects.toMatchObject({ statusCode: 503, code: 'AI_PAUSED' });
        expect(await buddyMaySpend(f.id)).toBe('allowance');
        // The app's routes answer the calm line; everything else works.
        const r = await api(f).post('/api/assistant/messages', { text: 'hi' });
        expect(r.status).toBe(503);
        expect(r.body).toMatchObject({ code: 'AI_PAUSED' });
        expect(r.body.message).toMatch(/free AI is used up/);
        expect((await api(f).get('/api/today')).status).toBe(200);
        expect((await api(f).get('/api/ai/access')).body.data).toMatchObject({ source: 'house', state: 'allowance', allowance: { reason: 'empty' } });

        expect((await api(owner).post(`/api/owner/people/${f.id}/top-up`, { amountUsd: 5 })).status).toBe(200);
        expect((await aiAccessFor(f.id)).state).toBe('ok');
        expect(await buddyMaySpend(f.id)).toBe('ok');
        expect((await allowanceOf(f.id))?.grantedUsd).toBe(10);
    });

    it('$1 a day stops them for the day, whatever they spent before today; the owner can change it', async () => {
        const f = await friend(5);
        await spend(f.id, 0.5, new Date(Date.now() - 2 * 86_400_000 + 60_000));
        await spend(f.id, 1.0);
        expect((await allowanceOf(f.id))?.reason).toBe('day');
        await expect(ask(f.id)).rejects.toMatchObject({ code: 'AI_PAUSED' });
        expect((await api(owner).patch(`/api/owner/people/${f.id}`, { dailyCapUsd: 2 })).status).toBe(200);
        expect(await allowanceOf(f.id)).toMatchObject({ reason: null, dailyCapUsd: 2 });
    });

    it('another person’s grant is never used: an account without one stays off the server’s key', async () => {
        await friend(5);
        const plain = await createTestUser();
        expect(await aiAccessFor(plain.id)).toMatchObject({ source: 'none', state: 'off' });
        await expect(ask(plain.id)).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    });

    it('the friends’ ceiling stops every friend and never the owner', async () => {
        const a = await friend(50);
        const b = await friend(50);
        // This month's friends so far (the other cases' spend), plus $3.
        const ceilingUsd = Math.round(((await friendsMonthSpend()).spentUsd + 3) * 100) / 100;
        expect((await api(owner).patch('/api/owner/friends', { ceilingUsd })).body.data).toEqual({ ceilingUsd });
        await spend(a.id, 0.9);
        await spend(b.id, 0.9);
        await spend(owner.id, 40); // the owner's spend is never a friend's
        expect((await allowanceOf(a.id))?.reason).toBeNull();
        await spend(a.id, 0.8);
        await spend(b.id, 0.5);
        expect((await allowanceOf(b.id))?.reason).toBe('ceiling');
        expect((await aiAccessFor(a.id)).state).toBe('allowance');
        expect((await aiAccessFor(owner.id)).state).toBe('ok');
        fake.push(fakeMessage('fine'));
        await expect(ask(owner.id)).resolves.toBeTruthy();
        await api(owner).patch('/api/owner/friends', { ceilingUsd: 25 });
    });

    it('their own key spends nothing of it (the meter says whose key paid)', async () => {
        const f = await friend(5);
        await recordAiUsage(f.id, 'assistant', fakeMessage('x', { usage: { input_tokens: 400_000 } }), { source: 'own' });
        expect((await allowanceOf(f.id))?.usedUsd).toBe(0);
    });
});

describe('ending access (stage 11)', () => {
    it('stops sign-in and every request, keeps the account, and the owner can restore it; never the owner’s own', async () => {
        const f = await createTestUser({ email: mail('ended') });
        expect((await api(owner).post(`/api/owner/people/${f.id}/end-access`)).status).toBe(200);
        const r = await api(f).get('/api/today');
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('ACCESS_ENDED');
        expect((await request(app).post('/api/login').send({ email: f.email, password: TEST_PASSWORD })).status).toBe(403);
        expect(await buddyMaySpend(f.id)).toBe('not_allowed');
        expect((await api(owner).post(`/api/owner/people/${owner.id}/end-access`)).status).toBe(400);
        expect((await api(owner).post(`/api/owner/people/${f.id}/restore-access`)).status).toBe(200);
        expect((await request(app).get('/api/today').set('Cookie', authCookie(f))).status).toBe(200);
    });
});

describe('feedback and the phone’s diagnostics (stage 11)', () => {
    it('reach the owner’s People page; the diagnostics take facts only', async () => {
        const f = await createTestUser({ name: 'Ravi Tester' });
        expect((await api(f).post('/api/feedback', { text: '  The reminders are great.  ', page: '/settings' })).status).toBe(201);
        expect((await api(f).post('/api/feedback', { text: '   ' })).status).toBe(400);
        expect((await api(f).post('/api/phone/diagnostics', { model: 'Phone X', android: '14', sdk: 34, screen: { width: 1080, height: 2400, density: 2.75 }, permissions: { exactAlarms: true, notifications: false } })).status).toBe(201);
        expect((await api(f).post('/api/phone/diagnostics', { notes: 'free text is refused' })).status).toBe(400);
        const page = (await api(owner).get('/api/owner/people')).body.data;
        expect(page.feedback[0]).toMatchObject({ personId: f.id, name: 'Ravi Tester', text: 'The reminders are great.', source: 'web', page: '/settings' });
        expect(page.people.find((p: { id: string }) => p.id === f.id).phone.details).toMatchObject({ model: 'Phone X', sdk: 34 });
    });
});
