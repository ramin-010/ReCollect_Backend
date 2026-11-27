// The phone app's public doors (ANDROID_APP_SPEC, PHONE_UPDATE_PLAN): the page its connect code opens, the app's own
// file, and what that file is (the app's updater reads it). None needs a sign-in: the page holds no secret (the token
// stays in the link's fragment), and neither the APK nor its description holds one.
import fs from 'node:fs';
import express from 'express';
import { CONNECT_PAGE_HEADERS, connectPage } from '../services/ambient/connectPage';
import { phoneApkPath, phoneRelease, qaApkPath, type PhoneBuild } from '../services/ambient/phoneRelease';

export { phoneApkPath } from '../services/ambient/phoneRelease';

const router = express.Router();

function sizeOf(file: string): number | null {
    try {
        const stat = fs.statSync(file);
        return stat.isFile() ? stat.size : null;
    } catch {
        return null;
    }
}

router.get('/phone/connect', (_req, res) => {
    res.set(CONNECT_PAGE_HEADERS).send(connectPage(sizeOf(phoneApkPath())));
});

const APK_HEADERS = (name: string) => ({ 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-cache' });

// The app's file under its name (and the old name, for links already shared).
router.get(['/phone/kaaga.apk', '/phone/recollect.apk'], (_req, res) => {
    if (sizeOf(phoneApkPath()) === null) {
        res.status(404).type('text/plain').send("This server doesn't have the phone app's file yet.");
        return;
    }
    res.set(APK_HEADERS('kaaga.apk'));
    res.sendFile(phoneApkPath());
});

// The QA app's file: only on the computer that builds it (production has no android/build).
router.get('/phone/kaaga-qa.apk', (_req, res) => {
    if (sizeOf(qaApkPath()) === null) {
        res.status(404).type('text/plain').send("This server doesn't have the QA app's file.");
        return;
    }
    res.set(APK_HEADERS('kaaga-qa.apk'));
    res.sendFile(qaApkPath());
});

/** What the file is: the app's updater compares its build number with its own (PHONE_UPDATE_PLAN §2). */
const describe = (build: PhoneBuild): express.RequestHandler => (_req, res, next) => {
    phoneRelease(build).then((release) => {
        res.set('Cache-Control', 'no-cache');
        if (!release) {
            res.status(404).json({ success: false, message: 'No phone app release on this server.' });
            return;
        }
        res.json({ success: true, data: release });
    }, next);
};
router.get('/phone/kaaga.json', describe('app'));
router.get('/phone/kaaga-qa.json', describe('qa'));

export default router;
