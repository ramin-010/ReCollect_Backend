// TOOL_ACCESS_PLAN §11.3 (11-27): files on a note, for agents. Thin: a multipart body (a coding tool's file from disk)
// goes through the upload rule's multer; JSON carries a file's text or its bytes as base64 (a web chat).
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { agentActor } from '../services/agent/agentEditLog';
import { FILE_BASE64_MAX, FILE_TEXT_MAX, attachFileForAgent, readFileForAgent, removeFileForAgent } from '../services/agent/agentNoteFiles.service';
import { learningUploadMiddleware } from '../services/learningDb/uploads.service';
import { LearningHttpError } from '../services/learning/http';
import { handler, ok, param, parse } from './learning/common';

/** multer only for a multipart body; JSON passes as it is. */
export const noteFileBody: RequestHandler = (req, res, next) => (req.is('multipart/form-data') ? learningUploadMiddleware(req, res, next) : next());

const name = z.string().trim().min(1, 'The file needs a name, with its extension').max(200);
const jsonSchema = z.union([
    z.object({ name, text: z.string().max(FILE_TEXT_MAX) }).strict(),
    // base64 grows a third: 1 MB of bytes is about 1.4 M characters.
    z.object({ name, base64: z.string().min(1).max(Math.ceil((FILE_BASE64_MAX * 4) / 3) + 64) }).strict(),
]);

/** POST /api/agent/notes/:id/files */
export const attachFile = handler(async (req, res) => {
    const file = (req as { file?: { buffer: Buffer; originalname: string; mimetype: string } }).file;
    if (req.is('multipart/form-data')) {
        if (!file) throw new LearningHttpError(400, 'NO_FILE', 'Send the file in the field "file".');
        ok(res, await attachFileForAgent(agentActor(req), param(req, 'id'), { buffer: file.buffer, name: file.originalname, type: file.mimetype }), 201);
        return;
    }
    ok(res, await attachFileForAgent(agentActor(req), param(req, 'id'), parse(jsonSchema, req.body)), 201);
});

const removeSchema = z
    .object({ name: z.string().trim().min(1).max(200).optional(), publicId: z.string().trim().min(1).max(512).optional(), n: z.number().int().min(1).max(100).optional() })
    .refine((v) => [v.name, v.publicId, v.n].filter((x) => x !== undefined).length === 1, 'Name the file: name, n (its number) or publicId, one of them');

/** POST /api/agent/notes/:id/files/remove */
export const removeFile = handler(async (req, res) => {
    ok(res, await removeFileForAgent(agentActor(req), param(req, 'id'), parse(removeSchema, req.body ?? {})));
});

/** GET /api/agent/notes/:id/files/:n (its number, or its name) */
export const readFile = handler(async (req, res) => {
    ok(res, await readFileForAgent(requireUser(req).id, param(req, 'id'), decodeURIComponent(param(req, 'n'))));
});
