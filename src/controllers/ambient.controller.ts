// GET /api/ambient/widget and /api/ambient/wallpaper.png (ALWAYS_ON_SPEC 6.6): the phone's wallpaper
// and widget, drawn from the brief. A cookie session, a token with `read`, or the phone app's own
// `ambient` token (ANDROID_APP_SPEC), which fetches the picture a few times a day.
import sharp from 'sharp';
import os from 'node:os';
import { requireUser } from '../middlwares/auth';
import { dayBreakdown, dayNumbers, getAmbient, markPhoneHeld, upcomingAlarms, wallpaperPngWithSlot, type Ambient } from '../services/ambient/ambient.service';
import { setLater } from '../services/ahead/later';
import { pictureZoom } from '../services/ambient/wallpaperArt';
import { phoneBuddy } from '../services/buddy/voice';
import { WALLPAPER_STYLES } from '../services/ambient/wallpaperStyles';
import { revokeApiToken } from '../services/apiTokens/apiTokens.service';
import ErrorResponse from '../utils/errorResponse';
import { z } from 'zod';
import { handler, ok, parse } from './learning/common';

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

/** `?app=0.6.0` (the phone app's version), or null. */
const appFrom = (q: unknown) => (typeof q === 'string' && /^\d+\.\d+\.\d+(-[a-z]+)?$/.test(q) ? q : null);

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
    const titles = titlesFrom(req.query.titles);
    // Stage 6: `?app=0.6.0` (the app's version): from 0.6.0 the day carries the questions and each word's end time.
    const app = appFrom(req.query.app);
    // `quiet=1`: the phone is in its quiet hours (no questions then, and none marked as shown).
    const quiet = req.query.quiet === '1';
    const appUrl = process.env.FRONTEND_URL?.trim().replace(/\/+$/, '') || null;
    const [ambient, buddy, alarms] = await Promise.all([getAmbient(user.id, now, { titles, app, quiet, appUrl }), phoneBuddy(user.id, now), upcomingAlarms(user.id, now, titles !== false)]);
    ok(res, { ...ambient, numbers: dayNumbers(ambient), breakdown: dayBreakdown(ambient), buddy, alarms, appUrl, account: { name: user.name, email: user.email } });
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
/** POST /api/ambient/reminders/scheduled {ids} (the phone app's token): the reminders it will ring for; no email goes for them (app 0.5.0). */
export const ambientRemindersHeldHandler = handler(async (req, res) => {
    const input = parse(z.object({ ids: z.array(z.string().trim().min(1).max(64)).max(50) }).strict(), req.body);
    ok(res, await markPhoneHeld(requireUser(req).id, input.ids));
});

/** POST /api/ambient/later {id} (the phone app's token, or the app): Later on the widget's card (stage 19) → { id, at, label }. */
export const ambientLaterHandler = handler(async (req, res) => {
    // `tappedAt` (app 0.7.0): when the tap was made, for a tap the phone kept while offline (later.ts tapMoment). `at` (app
    // 0.7.1): the time the button showed, kept when it still holds (later.ts shownTime: "at the time shown", the owner).
    const input = parse(z.object({ id: z.string().trim().min(4).max(64), tappedAt: z.iso.datetime({ offset: true }).optional(), at: z.iso.datetime({ offset: true }).optional() }).strict(), req.body);
    ok(res, await setLater(requireUser(req).id, input.id, new Date(), input.tappedAt ? new Date(input.tappedAt) : null, input.at ? new Date(input.at) : null));
});

export const ambientStylesHandler = handler(async (_req, res) => {
    ok(res, WALLPAPER_STYLES);
});

/**
 * GET /api/ambient/wallpaper.png?w=1080&h=2340&theme=dark|light[&titles=0][&screen=lock|home][&style=peaks&color=dusk][&zoom=1.1][&icons=1]
 * `zoom` (B8): how much larger the phone shows the picture at rest (1–1.25; Android 11's home screen: 1.1).
 */
/** The pictures drawn lately, by their key (a few dozen at most: each is one PNG of a phone screen). */
const PICTURES = new Map<string, { png: Buffer; slot: string | null }>();
const PICTURES_MAX = 24;

function rememberPicture(key: string, drawn: { png: Buffer; slot: string | null }): void {
    PICTURES.delete(key);
    PICTURES.set(key, drawn);
    while (PICTURES.size > PICTURES_MAX) PICTURES.delete(PICTURES.keys().next().value as string);
}

/** A short fingerprint of a picture's key (FNV-1a), for its ETag. */
export function pictureEtag(text: string): string {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
}

/**
 * The plain twin of the day (stage 6): the same picture without the buddy's words, under its own key. 11-21: a row the
 * line stood in for (a Later back at its time) is back in it.
 */
function plainTwin(a: Ambient): Ambient {
    const { insight: _insight, insightUntil: _until, todayPlain, ...rest } = a;
    void _insight;
    void _until;
    return { ...rest, line: null, ...(todayPlain ? { today: todayPlain } : {}), ...(a.plainKey ? { key: a.plainKey } : {}) };
}

export const ambientWallpaperHandler = handler(async (req, res) => {
    const width = size(req.query.w, 1080, 320, 2160);
    const height = size(req.query.h, 2340, 480, 4680);
    const theme = req.query.theme === 'light' ? 'light' : 'dark';
    // The lock screen gets its own picture (the dial); the home screen, and an app that doesn't ask, the sky.
    const screen = req.query.screen === 'lock' ? 'lock' : 'home';
    // Stage 6: `plain=1` draws the plain twin (no words from the buddy); `app=0.6.0` lets a question be the lock line.
    const plain = req.query.plain === '1';
    // Stage 19: `card=0`: a widget shows the card on the home screen, so the picture leaves that item out.
    const full = await getAmbient(requireUser(req).id, new Date(), { titles: titlesFrom(req.query.titles), app: appFrom(req.query.app), quiet: req.query.quiet === '1', withoutCard: req.query.card === '0' });
    const ambient = plain ? plainTwin(full) : full;
    // 0.7.3 (the owner: the pictures took long to come): `format=webp` sends the same picture as WebP, a tenth of the PNG's
    // size (a full-screen PNG is about 3 MB); Android and the browsers decode it. Older apps ask for nothing and get PNG.
    const webp = req.query.format === 'webp';
    res.setHeader('Content-Type', webp ? 'image/webp' : 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Ambient-State', ambient.state);
    const style = word(req.query.style);
    const color = word(req.query.color);
    const zoom = pictureZoom(req.query.zoom);
    // 11-22: the screen's layout, the person's choice in the app ("glass", "stack"; else the classic one).
    const layout = req.query.layout === 'glass' || req.query.layout === 'stack' ? req.query.layout : undefined;
    // `icons=1` (the live lock screen, app 0.4.0): a band under the words for the phone's notification
    // icons; its place in X-Ambient-Icons ("cy,size,#AARRGGBB", picture pixels).
    const iconSlot = req.query.icons === '1';
    // 0.5.2 (ECOSYSTEM_V2_PLAN stage 1): the same picture is drawn once. Its key is the day's key (everything
    // the pictures draw) and how it is drawn; a phone that already has it gets 304 with no body.
    const userId = requireUser(req).id;
    const etag = `"${pictureEtag([userId, ambient.key, width, height, theme, screen, style ?? '', color ?? '', zoom, iconSlot ? 1 : 0, plain ? 'plain' : '', webp ? 'webp' : '', layout ?? ''].join('|'))}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
    }
    let drawn = PICTURES.get(etag);
    if (!drawn) {
        drawn = wallpaperPngWithSlot(ambient, width, height, theme, screen, { ...(style ? { style } : {}), ...(color ? { color } : {}), ...(zoom !== 1 ? { zoom } : {}), ...(iconSlot ? { iconSlot } : {}), ...(layout ? { layout } : {}) });
        if (webp) drawn = { png: await sharp(drawn.png).webp({ quality: 90, effort: 2 }).toBuffer(), slot: drawn.slot };
    }
    rememberPicture(etag, drawn);
    const { png, slot } = drawn;
    if (slot) {
        res.setHeader('X-Ambient-Icons', slot);
        res.setHeader('Access-Control-Expose-Headers', 'X-Ambient-Icons');
    }
    res.send(png);
});
