// The doors (hosting P1-3, P1-4, P1-5): who may make an account, the client's address behind the
// tunnel, the limiter's answers, who may use the AI and how high a cap may go. No database.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { assertSignupAllowed, signupAllowed, signupAllowlist, signupMode } from '../../../src/config/signup';
import { clientIp, isLoopback } from '../../../src/utils/clientIp';
import { DOORS, doorLimit } from '../../../src/middlwares/rateLimit';
import { aiAllowedEmails, aiMaxCapUsd, MAX_MONTHLY_CAP_USD } from '../../../src/config/aiAccess';

const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers }) as never;

describe('SIGNUP_MODE (P1-3)', () => {
    it('open by default; allowlist names who; closed (and anything unknown) nobody', () => {
        expect(signupMode({})).toBe('open');
        expect(signupMode({ SIGNUP_MODE: 'Allowlist' })).toBe('allowlist');
        expect(signupMode({ SIGNUP_MODE: 'closed' })).toBe('closed');
        expect(signupMode({ SIGNUP_MODE: 'clsoed' })).toBe('closed');
        expect(signupAllowlist({ SIGNUP_ALLOWLIST: ' Ramin@Example.org, second@example.org  third@example.org' })).toEqual(['ramin@example.org', 'second@example.org', 'third@example.org']);

        expect(signupAllowed('anyone@example.org', {})).toBe(true);
        const allow = { SIGNUP_MODE: 'allowlist', SIGNUP_ALLOWLIST: 'ramin@example.org' };
        expect(signupAllowed(' RAMIN@example.org ', allow)).toBe(true);
        expect(signupAllowed('stranger@example.org', allow)).toBe(false);
        expect(signupAllowed('ramin@example.org', { SIGNUP_MODE: 'closed', SIGNUP_ALLOWLIST: 'ramin@example.org' })).toBe(false);
        expect(() => assertSignupAllowed('stranger@example.org', allow)).toThrow(expect.objectContaining({ statusCode: 403 }));
    });
});

describe('the client address (P1-4)', () => {
    it('CF-Connecting-IP only with TRUST_CF_IP=1 and a loopback peer; a forged header from anywhere else is ignored', () => {
        const cf = { 'cf-connecting-ip': '198.51.100.7' };
        expect(clientIp(req('127.0.0.1', cf), { TRUST_CF_IP: '1' })).toBe('198.51.100.7');
        expect(clientIp(req('::1', cf), { TRUST_CF_IP: '1' })).toBe('198.51.100.7');
        expect(clientIp(req('::ffff:127.0.0.1', cf), { TRUST_CF_IP: '1' })).toBe('198.51.100.7');
        expect(clientIp(req('203.0.113.9', cf), { TRUST_CF_IP: '1' })).toBe('203.0.113.9'); // forged from outside
        expect(clientIp(req('127.0.0.1', cf), {})).toBe('127.0.0.1'); // not trusted without the setting
        expect(clientIp(req('127.0.0.1', { 'cf-connecting-ip': 'not an address' }), { TRUST_CF_IP: '1' })).toBe('127.0.0.1');
        expect(isLoopback('127.4.5.6')).toBe(true);
        expect(isLoopback('10.0.0.1')).toBe(false);
    });
});

describe('the limiter (P1-4)', () => {
    const appWith = (door: Parameters<typeof doorLimit>[0], env: NodeJS.ProcessEnv, status = 400) => {
        const app = express();
        app.use(express.json());
        app.post('/door', doorLimit(door, { force: true, env }), (_req, res) => {
            res.status(status).json({ ok: status < 400 });
        });
        return app;
    };

    it('a pass-through under NODE_ENV=test unless forced', async () => {
        const app = express();
        app.use(express.json());
        app.post('/door', doorLimit('login', { env: { NODE_ENV: 'test' } }), (_req, res) => void res.json({ ok: true }));
        for (let i = 0; i < DOORS.login.perIp + 5; i++) expect((await request(app).post('/door').send({ email: 'a@example.org' })).status).toBe(200);
    });

    it('per address: the next try past the limit answers 429', async () => {
        const app = appWith('signup', {});
        for (let i = 0; i < DOORS.signup.perIp; i++) expect((await request(app).post('/door').send({})).status).toBe(400);
        const over = await request(app).post('/door').send({});
        expect(over.status).toBe(429);
        expect(over.body).toEqual({ success: false, code: 'RATE_LIMITED', message: 'Too many tries. Wait a few minutes and try again.' });
    });

    it('per email, whatever the address (through the tunnel, each visitor has their own)', async () => {
        const app = appWith('login', { TRUST_CF_IP: '1' });
        for (let i = 0; i < DOORS.login.perEmail; i++) {
            expect((await request(app).post('/door').set('CF-Connecting-IP', `198.51.100.${i + 1}`).send({ email: 'Ramin@Example.org' })).status).toBe(400);
        }
        expect((await request(app).post('/door').set('CF-Connecting-IP', '198.51.100.99').send({ email: 'ramin@example.org' })).status).toBe(429);
        expect((await request(app).post('/door').set('CF-Connecting-IP', '198.51.100.99').send({ email: 'someone@example.org' })).status).toBe(400);
    });

    it('without TRUST_CF_IP a changing CF-Connecting-IP does not escape the address limit', async () => {
        const app = appWith('google', {});
        for (let i = 0; i < DOORS.google.perIp; i++) await request(app).post('/door').set('CF-Connecting-IP', `198.51.100.${i + 1}`).send({});
        expect((await request(app).post('/door').set('CF-Connecting-IP', '198.51.100.200').send({})).status).toBe(429);
    });

    it('/mcp counts only the refusals: a valid token passes freely', async () => {
        const ok = appWith('mcp', {}, 200);
        for (let i = 0; i < DOORS.mcp.perIp + 5; i++) expect((await request(ok).post('/door').send({})).status).toBe(200);
        const refused = appWith('mcp', {}, 401);
        for (let i = 0; i < DOORS.mcp.perIp; i++) expect((await request(refused).post('/door').send({})).status).toBe(401);
        expect((await request(refused).post('/door').send({})).status).toBe(429);
    });
});

describe('AI_ALLOWED_EMAILS and AI_MAX_CAP_USD (P1-5)', () => {
    it('the list, lower-cased; unset: everyone', () => {
        expect(aiAllowedEmails({})).toBeNull();
        expect(aiAllowedEmails({ AI_ALLOWED_EMAILS: ' Ramin@Example.org ,' })).toEqual(['ramin@example.org']);
    });

    it("the cap's bound: AI_MAX_CAP_USD when it is a number from 0, else today's 1000", () => {
        expect(MAX_MONTHLY_CAP_USD).toBe(1000);
        expect(aiMaxCapUsd({})).toBe(1000);
        expect(aiMaxCapUsd({ AI_MAX_CAP_USD: '70' })).toBe(70);
        expect(aiMaxCapUsd({ AI_MAX_CAP_USD: '0' })).toBe(0);
        for (const bad of ['-5', 'lots', '']) expect(aiMaxCapUsd({ AI_MAX_CAP_USD: bad })).toBe(1000);
    });
});
