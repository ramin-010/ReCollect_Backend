// Stage 11 of ECOSYSTEM_V2_PLAN (§9.6 item 6): "Download everything" holds only that person's rows and no secret; an
// account made with Google deletes itself with its typed email (a password account with its password, as before),
// and nothing of it is left.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { createApiToken } from '../../src/services/apiTokens/apiTokens.service';
import { createDocFromMarkdown } from '../../src/services/agent/agentDocs.service';
import { authCookie, createTestUser, TEST_PASSWORD } from '../helpers/auth';
import { api } from '../helpers/learning';

describe('the account-wide export (stage 11)', () => {
    it('holds this person’s docs as Markdown, tasks, buddy and AI, and nothing of anyone else’s or any secret', async () => {
        const me = await createTestUser({ name: 'Nia Export' });
        const other = await createTestUser();
        await createDocFromMarkdown(me.id, { title: 'Sliding window', markdown: '## The idea\n\nTwo pointers move right.' } as never);
        await createDocFromMarkdown(other.id, { title: 'Not mine', markdown: 'Someone else’s words.' } as never);
        await prisma.todo.create({ data: { userId: me.id, title: 'Book the dentist' } as never });
        const token = await createApiToken(me.id, { name: 'Claude Code', scopes: ['read'] });
        await prisma.memory.create({ data: { userId: me.id, kind: 'fact', text: 'Learns Go at night', source: 'app', firstSeenDay: new Date(Date.UTC(2026, 10, 1)), lastSeenDay: new Date(Date.UTC(2026, 10, 1)) } as never });

        const res = await api(me).get('/api/account/export');
        expect(res.status).toBe(200);
        expect(res.headers['content-disposition']).toMatch(/attachment; filename="recollect-export-\d{4}-\d{2}-\d{2}\.json"/);
        const data = res.body.data;
        expect(data).toMatchObject({ format: 'recollect-export', version: 1, account: { name: 'Nia Export', email: me.email } });
        expect(data.docs.map((d: { title: string }) => d.title)).toEqual(['Sliding window']);
        expect(data.docs[0].markdown).toContain('Two pointers move right.');
        expect(data.tasks.map((t: { title: string }) => t.title)).toEqual(['Book the dentist']);
        expect(data.buddy.memories.map((m: { text: string }) => m.text)).toContain('Learns Go at night');
        expect(data.connectedApps).toEqual([expect.objectContaining({ name: 'Claude Code', prefix: token.token.slice(0, 12) })]);

        const all = JSON.stringify(data);
        expect(all).not.toContain('Someone else’s words.');
        expect(all).not.toContain(token.token);
        expect(all).not.toMatch(/tokenHash|"password"|cipher|\$2[aby]\$/);
        // Tokens can't fetch it (the app's cookie only).
        expect((await request(app).get('/api/account/export').set('Authorization', `Bearer ${token.token}`)).status).toBe(403);
    });
});

describe('deleting an account (stage 11)', () => {
    it('a Google account confirms with its typed email; a password account with its password; nothing of it is left', async () => {
        const g = await createTestUser({ authProvider: 'google', email: `g-${Date.now()}@example.test` });
        await prisma.todo.create({ data: { userId: g.id, title: 'Left behind?' } as never });
        expect((await request(app).delete('/api/account').set('Cookie', authCookie(g)).send({ confirm: 'someone@else.test' })).status).toBe(400);
        const ok = await request(app).delete('/api/account').set('Cookie', authCookie(g)).send({ confirm: g.email.toUpperCase() });
        expect(ok.status).toBe(200);
        expect(await prisma.user.count({ where: { id: g.id } })).toBe(0);
        expect(await prisma.todo.count({ where: { userId: g.id } })).toBe(0);

        const p = await createTestUser();
        expect((await request(app).delete('/api/account').set('Cookie', authCookie(p)).send({ confirm: p.email })).status).toBe(400);
        expect((await request(app).delete('/api/account').set('Cookie', authCookie(p)).send({ password: TEST_PASSWORD })).status).toBe(200);
        expect(await prisma.user.count({ where: { id: p.id } })).toBe(0);
    });
});
