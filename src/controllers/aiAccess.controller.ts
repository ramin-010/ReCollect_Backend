// The account's AI now (ECOSYSTEM_V2_PLAN stage 2): whose key pays, and whether it works. Outside the
// AI routes' own checks, so they answer even when the AI is off or paused (the apps show one calm line).
//
//   GET  /api/ai/access         → { source, state, since }
//   POST /api/ai/access/retry   → the same, after probing a paused key now (at most once a minute)
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { handler, ok, parse } from './learning/common';
import { prisma } from '../db/prisma';
import { aiAccessFor } from '../services/claude/access';
import { probeKey } from '../services/claude/client';
import { ownKeyView, removeOwnKey, setOwnKey } from '../services/claude/ownKeys';
import { poke } from '../services/scheduler/scheduler';

/** A paused key is asked again on "Try again" at most this often. */
export const RETRY_GAP_MS = 60_000;

export const accessHandler = handler(async (req, res) => {
    ok(res, await aiAccessFor(requireUser(req).id, { cap: true }));
});

/** Stage 10: GET /api/ai/key → their own key's last 4, when added and checked, its state (or null). */
export const ownKeyHandler = handler(async (req, res) => {
    ok(res, await ownKeyView(requireUser(req).id));
});

/** Stage 10: PUT /api/ai/key {key} → checked on each model the app calls, then kept encrypted. The key is never echoed. */
export const setOwnKeyHandler = handler(async (req, res) => {
    const input = parse(z.object({ key: z.string().trim().min(10).max(400) }).strict(), req.body);
    ok(res, await setOwnKey(requireUser(req).id, input.key));
});

/** Stage 10: DELETE /api/ai/key → removed at once. */
export const removeOwnKeyHandler = handler(async (req, res) => {
    ok(res, await removeOwnKey(requireUser(req).id));
});

export const retryHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const before = await aiAccessFor(userId);
    if (before.keyId && (before.state === 'no_credit' || before.state === 'bad_key')) {
        const row = await prisma.aiKeyState.findUnique({ where: { keyId: before.keyId }, select: { updatedAt: true } });
        if (!row || Date.now() - row.updatedAt.getTime() >= RETRY_GAP_MS) {
            // Works again: the buddy's queue and nights start at once.
            if (await probeKey(before.keyId)) poke('capture', 'buddy');
        }
    }
    ok(res, await aiAccessFor(userId, { cap: true }));
});
