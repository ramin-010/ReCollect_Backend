// /api/canvas: the server's diagram tools for a board the browser shows (CANVAS_BLOCK_SPEC §9,
// "Step 3 endpoints"): "Tidy up" and "Save as SVG/PNG". Stateless; cookie or a token with `read`.
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { renderBoard, tidyBoard } from '../services/docs/canvasTools.service';
import { handler, ok, parse } from './learning/common';

const layoutSchema = z.object({
    board: z.unknown(),
    direction: z.enum(['LR', 'TB']).optional(),
});

/** POST /api/canvas/layout { board, direction? } → { board, report } */
export const layoutCanvas = handler(async (req, res) => {
    requireUser(req);
    const { board, direction } = parse(layoutSchema, req.body);
    ok(res, await tidyBoard(board, direction));
});

const renderSchema = z.object({
    board: z.unknown(),
    format: z.enum(['svg', 'png']),
    theme: z.enum(['light', 'dark']).default('light'),
});

/** POST /api/canvas/render { board, format: 'svg' | 'png', theme } → the image (image/svg+xml or image/png). */
export const renderCanvas = handler(async (req, res) => {
    requireUser(req);
    const { board, format, theme } = parse(renderSchema, req.body);
    const image = renderBoard(board, format, theme);
    res.status(200).type(image.contentType).set('Cache-Control', 'no-store').send(image.body);
});
