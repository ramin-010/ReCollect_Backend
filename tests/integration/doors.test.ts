// The doors on the real routes (hosting P1-3, P1-4, P1-5): signup closed or by list on every path
// that makes an account (a placeholder's claim too), existing accounts still log in; a code dies at
// its 5th wrong try and an email gets at most 3 codes an hour; AI only for the listed accounts, on
// every AI route, and a cap bounded by AI_MAX_CAP_USD. (The limiter itself: tests/unit/auth/doors.)
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/auth/google.service', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../src/services/auth/google.service')>();
    return { ...real, verifyGoogleIdentity: vi.fn(real.verifyGoogleIdentity) };
});

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { verifyGoogleIdentity } from '../../src/services/auth/google.service';
import { createPlaceholderUser } from '../../src/services/users/users.service';
import { resetOtpSendLimits } from '../../src/services/auth/otp.service';
import { setAiClientForTests } from '../../src/services/claude/client';
import { isUnderCap, monthlyCapOf } from '../../src/services/claude/usage.service';
import { buddyMaySpend } from '../../src/services/buddy/spend';
import { createTestUser, TEST_PASSWORD } from '../helpers/auth';
import { api } from '../helpers/learning';
import { lastOtpSentTo } from '../helpers/mail';
import { FakeClaude } from '../helpers/claude';

const SETTINGS = ['SIGNUP_MODE', 'SIGNUP_ALLOWLIST', 'AI_ALLOWED_EMAILS', 'AI_MAX_CAP_USD'] as const;
afterEach(() => {
    for (const k of SETTINGS) delete process.env[k];
    resetOtpSendLimits();
});

const google = (email: string) =>
    vi.mocked(verifyGoogleIdentity).mockResolvedValueOnce({ email, name: 'Google Person', googleId: `sub-${email}`, picture: undefined });
const allowOnly = (email: string) => {
    process.env.SIGNUP_MODE = 'allowlist';
    process.env.SIGNUP_ALLOWLIST = email;
};

describe('signup closed or by list (P1-3)', () => {
    const body = (email: string) => ({ name: 'New Person', email, password: 'a-long-password' });

    it('each path answers 403 off the list; an address on it works', async () => {
        allowOnly('allowed@example.org');
        for (const path of ['/api/signup', '/api/pre-signup']) {
            const res = await request(app).post(path).send(body('stranger@example.org'));
            expect(res.status, path).toBe(403);
            expect(res.body.message).toBe('New accounts are closed on this server.');
        }
        expect((await request(app).post('/api/verify-signup').send({ email: 'stranger@example.org', otp: '123456' })).status).toBe(403);
        google('stranger@example.org');
        expect((await request(app).post('/api/auth/google').send({ accessToken: 'fake' })).status).toBe(403);
        expect(await prisma.user.count({ where: { email: 'stranger@example.org' } })).toBe(0);

        expect((await request(app).post('/api/pre-signup').send(body('allowed@example.org'))).status).toBe(200);
        const code = lastOtpSentTo('allowed@example.org')!;
        const made = await request(app).post('/api/verify-signup').send({ email: 'allowed@example.org', otp: code });
        expect(made.status).toBe(201);
    });

    it("claiming a placeholder account is making one: refused off the list, by email and by Google", async () => {
        process.env.SIGNUP_MODE = 'closed';
        const ghost = await createPlaceholderUser('invited@example.org');
        expect((await request(app).post('/api/pre-signup').send(body('invited@example.org'))).status).toBe(403);
        google('invited@example.org');
        expect((await request(app).post('/api/auth/google').send({ accessToken: 'fake' })).status).toBe(403);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: ghost.id } })).isGhost).toBe(true);
    });

    it('existing accounts still log in, with a password or with Google, while signup is closed', async () => {
        process.env.SIGNUP_MODE = 'closed';
        const me = await createTestUser();
        expect((await request(app).post('/api/login').send({ email: me.email, password: TEST_PASSWORD })).status).toBe(200);
        google(me.email);
        expect((await request(app).post('/api/auth/google').send({ accessToken: 'fake' })).status).toBe(200);
    });
});

describe('codes (P1-4)', () => {
    it('the sixth wrong code fails even when right: the code died at its fifth wrong try', async () => {
        const email = 'codes@example.org';
        expect((await request(app).post('/api/otp/generate').send({ email })).status).toBe(200);
        const code = lastOtpSentTo(email)!;
        const wrong = code === '111111' ? '222222' : '111111';
        for (let i = 0; i < 5; i++) {
            const res = await request(app).post('/api/otp/verify').send({ email, otp: wrong });
            expect(res.status).toBe(400);
            expect(res.body.message).toBe('Invalid OTP. Please check and try again.');
        }
        const right = await request(app).post('/api/otp/verify').send({ email, otp: code });
        expect(right.status).toBe(400);
        expect(right.body.message).toBe('OTP has expired or does not exist. Please request a new one.');
    });

    it('a right code after four wrong ones still works', async () => {
        const email = 'four-wrong@example.org';
        await request(app).post('/api/otp/generate').send({ email });
        const code = lastOtpSentTo(email)!;
        const wrong = code === '111111' ? '222222' : '111111';
        for (let i = 0; i < 4; i++) await request(app).post('/api/otp/verify').send({ email, otp: wrong });
        expect((await request(app).post('/api/otp/verify').send({ email, otp: code })).status).toBe(200);
    });

    it('at most 3 codes an hour for one email, whichever way they are asked for', async () => {
        const me = await createTestUser({ email: 'reset-me@example.org' });
        expect((await request(app).post('/api/otp/generate').send({ email: me.email })).status).toBe(200);
        expect((await request(app).post('/api/forgot-password').send({ email: me.email })).status).toBe(200);
        expect((await request(app).post('/api/otp/generate').send({ email: me.email })).status).toBe(200);
        const fourth = await request(app).post('/api/forgot-password').send({ email: me.email });
        expect(fourth.status).toBe(429);
        expect(fourth.body.message).toMatch(/^Too many codes for this email\. Try again in \d+ minutes?\.$/);
        expect((await request(app).post('/api/otp/generate').send({ email: 'someone-else@example.org' })).status).toBe(200);
    });
});

describe('AI only for the listed accounts, and a bounded cap (P1-5)', () => {
    const fake = new FakeClaude();
    beforeAll(() => {
        process.env.CLAUDE_API_KEY = 'test-key-not-real';
        setAiClientForTests(fake);
    });
    afterAll(() => {
        process.env.CLAUDE_API_KEY = '';
        setAiClientForTests(null);
    });

    it('a second account gets 403 on every AI route; the listed one passes the gate', async () => {
        const [owner, second] = await Promise.all([createTestUser(), createTestUser()]);
        process.env.AI_ALLOWED_EMAILS = owner.email.toUpperCase();
        const routes: Array<[string, string, object?]> = [
            ['post', '/api/recall/start', { revisionId: 'x' }],
            ['post', '/api/recall/sets/x/answer', { questionId: 'q', answer: 'a' }],
            ['post', '/api/recall/sets/x/finish', {}],
            ['get', '/api/ai/usage'],
            ['patch', '/api/ai/settings', { capUsd: 10 }],
            ['post', '/api/ai/practice-note', { docId: 'x' }],
            ['get', '/api/ai/coach'],
            ['post', '/api/ai/coach', {}],
            ['post', '/api/assistant/messages', { text: 'hi' }],
            ['post', '/api/todos/ai/generate', { prompt: 'call the bank tomorrow' }],
            ['post', '/api/buddy/think', {}],
        ];
        await api(second).patch('/api/buddy/settings', { enabled: true });
        for (const [method, path, body] of routes) {
            const res = await (api(second) as any)[method](path, body);
            expect(res.status, `${method} ${path}`).toBe(403);
            if (path !== '/api/buddy/think' && path !== '/api/todos/ai/generate') expect(res.body.code, path).toBe('AI_NOT_ALLOWED');
        }
        expect((await api(owner).get('/api/ai/usage')).status).toBe(200);
        expect(await isUnderCap(second.id)).toBe(false); // the background work (buddy, Recall batch) skips it too
        expect(await buddyMaySpend(second.id)).toBe('not_allowed');
        expect(await isUnderCap(owner.id)).toBe(true);
        expect(fake.calls).toHaveLength(0);
    });

    it('AI_MAX_CAP_USD bounds the cap he may set, and a cap set before it', async () => {
        const me = await createTestUser();
        process.env.AI_MAX_CAP_USD = '70';
        expect((await api(me).patch('/api/ai/settings', { capUsd: 71 })).status).toBe(400);
        expect((await api(me).patch('/api/ai/settings', { capUsd: 70 })).status).toBe(200);
        await prisma.aiSettings.update({ where: { userId: me.id }, data: { monthlyCapUsd: '100.00' } });
        expect(await monthlyCapOf(me.id)).toBe(70);
        delete process.env.AI_MAX_CAP_USD;
        expect(await monthlyCapOf(me.id)).toBe(100);
        expect((await api(me).patch('/api/ai/settings', { capUsd: 1000 })).status).toBe(200); // today's bound when unset
    });
});
