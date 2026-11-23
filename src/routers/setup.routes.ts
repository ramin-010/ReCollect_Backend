// /api/setup: a PC signs in by approval (EASY_SETUP_PLAN §3.2; ../services/setup/deviceSignIn.service.ts). Mounted
// before userRoutes' login check: `start` and `poll` are public (the command has no login yet, only its device code);
// `request` and `answer` are the approve page's (their cookie only); `me` and `disconnect` are the PC's own token's.
import express from 'express';
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { doorLimit } from '../middlwares/rateLimit';
import { authOnce, cookieOnly, requireScope } from '../middlwares/scopes';
import { handler, ok, parse } from '../controllers/learning/common';
import { answerSignIn, disconnect, pollSignIn, setupMe, signInRequest, startSignIn } from '../services/setup/deviceSignIn.service';

export const setupRouter = express.Router();

setupRouter.post(
    '/start',
    doorLimit('setupStart'),
    handler(async (req, res) => {
        const body = parse(z.object({ device: z.string().max(200).optional() }).passthrough(), req.body ?? {});
        ok(res, await startSignIn({ device: body.device }), 201);
    })
);

setupRouter.post(
    '/poll',
    doorLimit('setupPoll'),
    handler(async (req, res) => {
        const body = parse(z.object({ deviceCode: z.string().max(200) }).passthrough(), req.body ?? {});
        ok(res, await pollSignIn(body.deviceCode));
    })
);

setupRouter.get(
    '/request',
    authOnce,
    cookieOnly,
    handler(async (req, res) => {
        ok(res, await signInRequest(requireUser(req).id, req.query['code']));
    })
);

setupRouter.post(
    '/answer',
    authOnce,
    cookieOnly,
    handler(async (req, res) => {
        const body = parse(z.object({ code: z.string().max(40), allow: z.boolean() }).strict(), req.body ?? {});
        ok(res, await answerSignIn(requireUser(req).id, body.code, body.allow));
    })
);

setupRouter.get(
    '/me',
    authOnce,
    requireScope('read'),
    handler(async (req, res) => {
        ok(res, await setupMe(requireUser(req).id, req.auth));
    })
);

setupRouter.post(
    '/disconnect',
    authOnce,
    requireScope('sessions:write'),
    handler(async (req, res) => {
        ok(res, await disconnect(requireUser(req).id, req.auth));
    })
);
