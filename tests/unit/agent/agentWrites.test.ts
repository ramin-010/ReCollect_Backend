// Drift guard (SYNC_SPINE_SPEC 0.4): every write an agent token may make is accounted for.
//   - Each TOKEN_ROUTES entry that is not a GET is in exactly one of LOGGED (an AgentEditKind:
//     Home's "From your agent" and Undo) or SELF_LOGGED (a reason it is no AgentEdit row).
//   - Every kind in LOGGED is a real AgentEditKind, and every AgentEditKind is written by some route.
//   - Undo: agentEdits.service.ts keys its Undo table by AgentEditKind (Record<AgentEditKind, …>),
//     so a kind without an Undo fails `npm run typecheck`.
import { describe, expect, it } from 'vitest';
import { AgentEditKind } from '@prisma/client';
import { LOGGED, SELF_LOGGED, TOKEN_ROUTES } from '../../../src/services/apiTokens/tokenRoutes';

const writes = TOKEN_ROUTES.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.pattern}`);

describe('agent writes are accounted for', () => {
    it('every token write is in exactly one of LOGGED and SELF_LOGGED', () => {
        const unaccounted = writes.filter((w) => !(w in LOGGED) && !(w in SELF_LOGGED));
        const both = writes.filter((w) => w in LOGGED && w in SELF_LOGGED);
        expect(unaccounted, 'add these to LOGGED or SELF_LOGGED in tokenRoutes.ts').toEqual([]);
        expect(both).toEqual([]);
    });

    it('the lists name only token routes that write', () => {
        const stale = [...Object.keys(LOGGED), ...Object.keys(SELF_LOGGED)].filter((w) => !writes.includes(w));
        expect(stale, 'not a token write in TOKEN_ROUTES').toEqual([]);
    });

    it('every logged kind is an AgentEditKind, and every AgentEditKind is written by a route', () => {
        const kinds = Object.values(AgentEditKind) as string[];
        expect(Object.values(LOGGED).filter((k) => !kinds.includes(k))).toEqual([]);
        const written = new Set<string>(Object.values(LOGGED));
        expect(kinds.filter((k) => !written.has(k)), 'a kind no token route writes').toEqual([]);
    });

    it('each self-logged write says why', () => {
        for (const reason of Object.values(SELF_LOGGED)) expect(reason.trim().length).toBeGreaterThan(10);
    });
});
