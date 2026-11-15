// GET /api/ambient/widget and /api/ambient/wallpaper.png (ALWAYS_ON_SPEC 6.6): the phone's wallpaper
// and widget, drawn from the brief. A cookie session or a token with `read` (an automation app on the
// phone fetches the picture a few times a day).
import os from 'node:os';
import { requireUser } from '../middlwares/auth';
import { getAmbient, wallpaperPng } from '../services/ambient/ambient.service';
import { handler, ok } from './learning/common';

/**
 * GET /api/ambient/addresses (cookie only) -> [{ url, kind }]: where the phone app can reach this
 * server, best first: the public address (RECOLLECT_SELF_URL, once deployed), each address on the
 * networks this computer is on (his phone's hotspot), and localhost (USB, with adb reverse).
 */
export const ambientAddressesHandler = handler(async (req, res) => {
    const port = req.socket.localPort ?? (Number(process.env.PORT) || 8002);
    const list: Array<{ url: string; kind: 'public' | 'network' | 'usb' }> = [];
    const self = process.env.RECOLLECT_SELF_URL?.trim().replace(/\/+$/, '');
    if (self && !/\/\/(localhost|127\.0\.0\.1)\b/.test(self)) list.push({ url: self, kind: 'public' });
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) list.push({ url: `http://${a.address}:${port}`, kind: 'network' });
    }
    list.push({ url: `http://localhost:${port}`, kind: 'usb' });
    ok(res, list);
});

/** GET /api/ambient/widget */
export const ambientWidgetHandler = handler(async (req, res) => {
    ok(res, await getAmbient(requireUser(req).id));
});

const size = (v: unknown, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** GET /api/ambient/wallpaper.png?w=1080&h=2340&theme=dark|light */
export const ambientWallpaperHandler = handler(async (req, res) => {
    const width = size(req.query.w, 1080, 320, 2160);
    const height = size(req.query.h, 2340, 480, 4680);
    const theme = req.query.theme === 'light' ? 'light' : 'dark';
    const ambient = await getAmbient(requireUser(req).id);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Ambient-State', ambient.state);
    res.send(wallpaperPng(ambient, width, height, theme));
});
