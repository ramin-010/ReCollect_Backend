// GET /api/health/db (hosting P1-8): one SELECT 1 for a manual check, for the owner's cookie only.
// (GET /healthz, which never touches the database, is tested in tests/unit/health/healthz.test.ts.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { Prisma } from '@prisma/client';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { authCookie, createTestUser } from '../helpers/auth';
import { asAgent, createTestToken } from '../helpers/agent';

afterEach(() => {
    delete process.env.OWNER_EMAIL;
    vi.restoreAllMocks();
});

describe('GET /api/health/db', () => {
    it('401 without a login', async () => {
        expect((await request(app).get('/api/health/db')).status).toBe(401);
    });

    it('OWNER_EMAIL unset: any signed-in cookie gets the database up and the time it took', async () => {
        const me = await createTestUser();
        const res = await request(app).get('/api/health/db').set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, data: { database: 'up', ms: expect.any(Number) } });
    });

    it('OWNER_EMAIL set: only that account (any letter case); others 403', async () => {
        const owner = await createTestUser();
        const other = await createTestUser();
        process.env.OWNER_EMAIL = `  ${owner.email.toUpperCase()} `;
        expect((await request(app).get('/api/health/db').set('Cookie', authCookie(owner))).status).toBe(200);
        const res = await request(app).get('/api/health/db').set('Cookie', authCookie(other));
        expect(res.status).toBe(403);
    });

    it('an access token gets 403, even the owner\'s', async () => {
        const owner = await createTestUser();
        process.env.OWNER_EMAIL = owner.email;
        const { token } = await createTestToken(owner);
        expect((await asAgent(token).get('/api/health/db')).status).toBe(403);
    });

    it("503 with the error's code (never its message) when the query fails", async () => {
        const me = await createTestUser();
        const cookie = authCookie(me);
        vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(
            new Prisma.PrismaClientKnownRequestError("Can't reach database server at `db.example:5432`", { code: 'P1001', clientVersion: '7.8.0' }),
        );
        const res = await request(app).get('/api/health/db').set('Cookie', cookie);
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ success: false, data: { database: 'down', ms: expect.any(Number), code: 'P1001' } });
        expect(JSON.stringify(res.body)).not.toContain('db.example');
    });

    it('/healthz makes no query while the database is up either', async () => {
        const query = vi.spyOn(pg.Client.prototype, 'query');
        expect((await request(app).get('/healthz')).status).toBe(200);
        expect(query).not.toHaveBeenCalled();
    });
});
