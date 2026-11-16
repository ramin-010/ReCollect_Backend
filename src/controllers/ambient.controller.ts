// GET /api/ambient/widget and /api/ambient/wallpaper.png (ALWAYS_ON_SPEC 6.6): the phone's wallpaper
// and widget, drawn from the brief. A cookie session, a token with `read`, or the phone app's own
// `ambient` token (ANDROID_APP_SPEC), which fetches the picture a few times a day.
import os from 'node:os';
import { requireUser } from '../middlwares/auth';
import { dayBreakdown, dayNumbers, getAmbient, wallpaperPng } from '../services/ambient/ambient.service';
import { pictureZoom } from '../services/ambient/wallpaperArt';
import { phoneBuddy } from '../services/buddy/voice';
import { WALLPAPER_STYLES } from '../services/ambient/wallpaperStyles';
import { revokeApiToken } from '../services/apiTokens/apiTokens.service';
import ErrorResponse from '../utils/errorResponse';
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

/** `?titles=0`: the phone app's "Hide titles" (counts and plain words, no topic or focus names). */
const titlesFrom = (q: unknown) => q !== '0' && q !== 'false';

/**
 * GET /api/ambient/widget[?titles=0] -> the day's lines, plus what the phone app's screen shows: whose
 * day it is (`account`), where a tap opens Recollect (`appUrl`, the web app; null when unknown), the
 * day in numbers for the widget (`numbers`), what is left by kind under it on the app's day card
 * (`breakdown`, B8) and the buddy's part of the app's screen (`buddy`: its
 * note, the lines it said, his thumbs; null while it is off). The widget itself keeps to `line`, the
 * lock-safe line (none with titles hidden).
 */
export const ambientWidgetHandler = handler(async (req, res) => {
    const user = requireUser(req);
    const now = new Date();
    const [ambient, buddy] = await Promise.all([getAmbient(user.id, now, { titles: titlesFrom(req.query.titles) }), phoneBuddy(user.id, now)]);
    const appUrl = process.env.FRONTEND_URL?.trim().replace(/\/+$/, '') || null;
    ok(res, { ...ambient, numbers: dayNumbers(ambient), breakdown: dayBreakdown(ambient), buddy, appUrl, account: { name: user.name, email: user.email } });
});

/**
 * POST /api/ambient/disconnect (the phone app's own `ambient` token only): the app's Disconnect ends
 * its token, so a phone that is lost or reset holds nothing that still works.
 */
export const ambientDisconnectHandler = handler(async (req, res) => {
    const user = requireUser(req);
    if (req.auth?.via !== 'token') throw new ErrorResponse(400, "Only the phone app's own token can disconnect itself. End a token in Settings → Agents.");
    await revokeApiToken(user.id, req.auth.tokenId);
    ok(res, { disconnected: true });
});

const size = (v: unknown, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

/** `?style=&color=`: a style the server knows (else the sky) and one of its colours (else its first). */
const word = (v: unknown) => (typeof v === 'string' && /^[a-z]{1,20}$/.test(v) ? v : undefined);

/** GET /api/ambient/styles (the phone app's style picker): the styles and their colours, the sky first. */
export const ambientStylesHandler = handler(async (_req, res) => {
    ok(res, WALLPAPER_STYLES);
});

/**
 * GET /api/ambient/wallpaper.png?w=1080&h=2340&theme=dark|light[&titles=0][&screen=lock|home][&style=peaks&color=dusk][&zoom=1.1]
 * `zoom` (B8): how much larger the phone shows the picture at rest (1–1.25; Android 11's home screen: 1.1).
 */
export const ambientWallpaperHandler = handler(async (req, res) => {
    const width = size(req.query.w, 1080, 320, 2160);
    const height = size(req.query.h, 2340, 480, 4680);
    const theme = req.query.theme === 'light' ? 'light' : 'dark';
    // The lock screen gets its own picture (the dial); the home screen, and an app that doesn't ask, the sky.
    const screen = req.query.screen === 'lock' ? 'lock' : 'home';
    const ambient = await getAmbient(requireUser(req).id, new Date(), { titles: titlesFrom(req.query.titles) });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Ambient-State', ambient.state);
    const style = word(req.query.style);
    const color = word(req.query.color);
    const zoom = pictureZoom(req.query.zoom);
    res.send(wallpaperPng(ambient, width, height, theme, screen, { ...(style ? { style } : {}), ...(color ? { color } : {}), ...(zoom !== 1 ? { zoom } : {}) }));
});
