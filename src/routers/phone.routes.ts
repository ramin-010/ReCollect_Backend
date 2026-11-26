// The phone app's two public doors (ANDROID_APP_SPEC): the page its connect code opens and the app's
// own file. Neither needs a sign-in: the page holds no secret (the token stays in the link's fragment)
// and the APK holds none either.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { CONNECT_PAGE_HEADERS, connectPage } from '../services/ambient/connectPage';

const router = express.Router();

/**
 * The app's file: KAAGA_APK_PATH (or the older RECOLLECT_APK_PATH) when set; else the copy committed with the backend
 * (assets/phone, written by android/build.mjs on every release build, so a backend deploy carries the newest app:
 * kaaga.apk since the rename, recollect.apk before it); else the Android build folder.
 */
export function phoneApkPath(): string {
    const env = (process.env.KAAGA_APK_PATH ?? process.env.RECOLLECT_APK_PATH)?.trim();
    if (env) return env;
    for (const name of ['kaaga.apk', 'recollect.apk']) {
        const shipped = path.resolve(__dirname, '..', '..', 'assets', 'phone', name);
        if (fs.existsSync(shipped)) return shipped;
    }
    const built = path.resolve(__dirname, '..', '..', '..', 'android', 'build');
    return fs.existsSync(path.join(built, 'kaaga.apk')) ? path.join(built, 'kaaga.apk') : path.join(built, 'recollect.apk');
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

// The app's file under its name (and the old name, for links already shared).
router.get(['/phone/kaaga.apk', '/phone/recollect.apk'], (_req, res) => {
    if (apkSize() === null) {
        res.status(404).type('text/plain').send("This server doesn't have the phone app's file yet.");
        return;
    }
    res.set({ 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="kaaga.apk"', 'Cache-Control': 'no-cache' });
    res.sendFile(phoneApkPath());
});

export default router;
