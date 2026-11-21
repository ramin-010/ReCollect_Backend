// BUDDY_OFFICE_CAPTURE=off (hosting P1-14): words a hook marked as office work are dropped on
// arrival and counted, never stored; a personal piece is queued as before; unset, office words are
// queued too (today's behaviour). The hook gets a 2xx either way, so it moves on.
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

afterEach(() => {
    delete process.env.BUDDY_OFFICE_CAPTURE;
});

async function hook() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true });
    const chat = asAgent((await createTestToken(user)).token, 'Claude Code hooks');
    const words = (seq: number, office: boolean) =>
        chat.post('/api/buddy/words', { sessionKey: `cc_office_${seq}`, seq, project: office ? 'erp-workspace' : 'second_brain', office, messages: [{ at: new Date().toISOString(), text: `piece ${seq}: rename the invoice service` }] });
    return { user, words };
}

describe('office words (P1-14)', () => {
    it('off: an office piece leaves no row and is counted as dropped; a personal piece is queued', async () => {
        process.env.BUDDY_OFFICE_CAPTURE = 'off';
        const { user, words } = await hook();
        const office = await words(1, true);
        expect(office.status).toBe(202);
        expect(office.body.data).toEqual({ queued: 0, office: true, capture: 2 });
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0);
        const day = await prisma.buddyCaptureDay.findFirstOrThrow({ where: { userId: user.id } });
        expect(day).toMatchObject({ seen: 1, dropped: 1, chunks: 0 });

        const personal = await words(2, false);
        expect(personal.status).toBe(202);
        expect(personal.body.data).toEqual({ queued: 1, capture: 2 });
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(1);
    });

    it('unset: an office piece is queued, marked as office work, as before', async () => {
        const { user, words } = await hook();
        expect((await words(3, true)).body.data).toEqual({ queued: 1, capture: 2 });
        expect(await prisma.buddyChunk.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ office: true });
    });
});
