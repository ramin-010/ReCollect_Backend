// The long run (BUDDY_MEMORY_PLAN §3.7, the parts built with B3): past 120 working memories the lowest
// scored fade; lasting, pinned and his own never do, however old; a faded memory seen again is active
// with its old dates. No AI involved.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { fadeMemories } from '../../src/services/buddy/think';
import { createTestUser } from '../helpers/auth';
import { asAgent, createTestToken } from '../helpers/agent';

const day = (d: string) => new Date(`${d}T00:00:00Z`);

describe('the long run', () => {
    it('200 working memories → 120 active (the lowest scored fade); 60 lasting, pinned and his own untouched', async () => {
        const user = await createTestUser();
        const rows = [];
        for (let i = 0; i < 200; i++) {
            // Half seen once long ago (they should go), half seen often lately.
            const old = i < 100;
            rows.push({ userId: user.id, text: `Working memory number ${i}`, kind: (i % 2 ? 'pattern' : 'win') as 'pattern' | 'win', lasting: false, source: 'buddy' as const, seenCount: old ? 1 : 5, firstSeenDay: day('2026-01-01'), lastSeenDay: old ? day('2026-06-01') : day('2026-11-15') });
        }
        for (let i = 0; i < 60; i++) rows.push({ userId: user.id, text: `Lasting memory number ${i}`, kind: (i % 2 ? 'fact' : 'aim') as 'fact' | 'aim', lasting: true, source: 'buddy' as const, seenCount: 1, firstSeenDay: day('2024-11-01'), lastSeenDay: day('2024-11-01') });
        for (let i = 0; i < 5; i++) rows.push({ userId: user.id, text: `Pinned working ${i}`, kind: 'pattern' as const, lasting: false, pinned: true, source: 'agent' as const, seenCount: 1, firstSeenDay: day('2025-01-01'), lastSeenDay: day('2025-01-01') });
        for (let i = 0; i < 5; i++) rows.push({ userId: user.id, text: `His own working ${i}`, kind: 'win' as const, lasting: false, byUser: true, source: 'app' as const, seenCount: 1, firstSeenDay: day('2025-01-01'), lastSeenDay: day('2025-01-01') });
        await prisma.memory.createMany({ data: rows });

        const faded = await fadeMemories(user.id, '2026-11-16' as never);
        expect(faded).toBe(80);
        const active = (where: object) => prisma.memory.count({ where: { userId: user.id, status: 'active', ...where } });
        expect(await active({ lasting: false, pinned: false, byUser: false })).toBe(120);
        expect(await active({ lasting: true })).toBe(60);
        expect(await active({ pinned: true })).toBe(5);
        expect(await active({ byUser: true })).toBe(5);
        // The ones that went are the ones seen once, long ago.
        expect(await prisma.memory.count({ where: { userId: user.id, status: 'faded', seenCount: 5 } })).toBe(0);
    });

    it('a faded memory seen again is active, with its first day kept', async () => {
        const user = await createTestUser();
        const m = await prisma.memory.create({ data: { userId: user.id, text: 'Runs in the evenings', kind: 'pattern', lasting: false, status: 'faded', source: 'agent', seenCount: 2, firstSeenDay: day('2026-03-01'), lastSeenDay: day('2026-05-01') } });
        const chat = asAgent((await createTestToken(user)).token);
        const res = await chat.post('/api/buddy/remember', { text: 'Runs in the evenings!', kind: 'pattern' });
        expect(res.body.data.notes[0]).toMatchObject({ status: 'seen', memory: { _id: m.id, status: 'active', seenCount: 3, firstSeenDay: '2026-03-01' } });
    });
});
