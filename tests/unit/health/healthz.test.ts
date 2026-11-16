// GET /healthz (hosting P1-8): 200 while the process is up, without touching the database. The unit
// project's DATABASE_URL points at a port where nothing listens, so this is "the database is
// unreachable"; the spies prove no connection or query is even tried.
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../../../src/app';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('GET /healthz', () => {
    it('200 with the database unreachable, and no connection or query tried', async () => {
        const connect = vi.spyOn(pg.Client.prototype, 'connect');
        const query = vi.spyOn(pg.Client.prototype, 'query');
        const poolConnect = vi.spyOn(pg.Pool.prototype, 'connect');

        const res = await request(createApp()).get('/healthz');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'ok' });
        expect(connect).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(poolConnect).not.toHaveBeenCalled();
    });

    it('needs no login and passes any Origin (it sits before CORS); never cached', async () => {
        const res = await request(createApp()).get('/healthz').set('Origin', 'https://elsewhere.example');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toContain('no-store');
    });

    it('answers GET only', async () => {
        expect((await request(createApp()).post('/healthz')).status).not.toBe(200);
    });
});
