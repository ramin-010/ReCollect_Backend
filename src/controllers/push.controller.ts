// /api/push/* (ALWAYS_ON_SPEC 6.3): the morning notification's subscriptions. Cookie only.
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { countSubscriptions, morningLine, PushNotConfigured, pushToUser, removeSubscription, saveSubscription, vapidPublicKey } from '../services/push/push.service';
import { handler, ok, parse } from './learning/common';
import ErrorResponse from '../utils/errorResponse';

const subscriptionBody = z
    .object({
        endpoint: z.string().url().max(2000),
        keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
    })
    .passthrough();

/** GET /api/push/status: the server's public key (null when not set up) and how many devices get it. */
export const pushStatusHandler = handler(async (req, res) => {
    ok(res, { publicKey: vapidPublicKey(), devices: await countSubscriptions(requireUser(req).id) });
});

/** POST /api/push/subscription (a browser's PushSubscription JSON) */
export const savePushSubscriptionHandler = handler(async (req, res) => {
    const sub = parse(subscriptionBody, req.body);
    ok(res, await saveSubscription(requireUser(req).id, { endpoint: sub.endpoint, keys: sub.keys }), 201);
});

/** DELETE /api/push/subscription { endpoint } */
export const removePushSubscriptionHandler = handler(async (req, res) => {
    const { endpoint } = parse(z.object({ endpoint: z.string().url().max(2000) }), req.body);
    ok(res, await removeSubscription(requireUser(req).id, endpoint));
});

/** POST /api/push/test: this morning's line now (or a placeholder line on an empty day). */
export const testPushHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    try {
        const line = (await morningLine(userId)) ?? { title: 'Kaaga', body: 'Notifications work. Nothing is planned for today.', url: '/' };
        ok(res, await pushToUser(userId, line));
    } catch (err) {
        if (err instanceof PushNotConfigured) throw new ErrorResponse(503, err.message);
        throw err;
    }
});
