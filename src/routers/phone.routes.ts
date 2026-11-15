// The phone app's two public doors (ANDROID_APP_SPEC): the page its connect code opens and the app's
// own file. Neither needs a sign-in: the page holds no secret (the token stays in the link's fragment)
// and the APK holds none either.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { CONNECT_PAGE_HEADERS, connectPage } from '../services/ambient/connectPage';

const router = express.Router();

/** The built app (android/build.mjs writes it); RECOLLECT_APK_PATH points elsewhere on a server. */
export function phoneApkPath(): string {
    return process.env.RECOLLECT_APK_PATH?.trim() || path.resolve(__dirname, '..', '..', '..', 'android', 'build', 'recollect.apk');
}

function apkSize(): number | null {
    try {
        const stat = fs.statSync(phoneApkPath());
        return stat.isFile() ? stat.size : null;
    } catch {
        return null;
    }
}

router.get('/phone/connect', (_req, res) => {
    res.set(CONNECT_PAGE_HEADERS).send(connectPage(apkSize()));
});

router.get('/phone/recollect.apk', (_req, res) => {
    if (apkSize() === null) {
        res.status(404).type('text/plain').send("This server doesn't have the phone app's file yet.");
        return;
    }
    res.set({ 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="recollect.apk"', 'Cache-Control': 'no-cache' });
    res.sendFile(phoneApkPath());
});

export default router;
