// The phone app's release on this server (PHONE_UPDATE_PLAN §2): the APK the app's own updater and Settings › Phone app
// offer, with what the app needs to judge it: its package, version, build number, notes, size and SHA-256.
//
// android/build.mjs writes a sidecar JSON beside every APK it builds (backend/assets/phone/kaaga.json for the release,
// committed with the APK; android/build/kaaga-qa.json for the QA app on this computer). The size and the checksum are
// measured from the file itself, never taken from the sidecar, so a stale sidecar can't state a wrong checksum.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export type PhoneBuild = 'app' | 'qa';

export interface PhoneRelease {
    /** The Android package the file installs (app.recollect.phone, or .qa for the QA app). */
    package: string;
    version: string;
    /** Android's build number: an update installs only over a lower one. */
    versionCode: number;
    minSdk: number | null;
    /** Up to three short lines: what is new. */
    notes: string[];
    size: number;
    sha256: string;
    /** Where the file is, on this server. */
    url: string;
    builtAt: string | null;
}

/**
 * The app's file: KAAGA_APK_PATH (or the older RECOLLECT_APK_PATH) when set; else the copy committed with the backend
 * (assets/phone, written by android/build.mjs on every release build, so a backend deploy carries the newest app:
 * kaaga.apk since the rename, recollect.apk before it); else the Android build folder.
 */
export function phoneApkPath(): string {
    const env = (process.env.KAAGA_APK_PATH ?? process.env.RECOLLECT_APK_PATH)?.trim();
    if (env) return env;
    for (const name of ['kaaga.apk', 'recollect.apk']) {
        const shipped = path.resolve(__dirname, '..', '..', '..', 'assets', 'phone', name);
        if (fs.existsSync(shipped)) return shipped;
    }
    const built = path.resolve(__dirname, '..', '..', '..', '..', 'android', 'build');
    return fs.existsSync(path.join(built, 'kaaga.apk')) ? path.join(built, 'kaaga.apk') : path.join(built, 'recollect.apk');
}

/** The QA app's file (build.mjs --qa): only on the computer that builds it; production has no android/build. */
export function qaApkPath(): string {
    const env = process.env.KAAGA_QA_APK_PATH?.trim();
    if (env) return env;
    return path.resolve(__dirname, '..', '..', '..', '..', 'android', 'build', 'kaaga-qa.apk');
}

const SIDECAR = z.object({
    package: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[a-z]+)?$/),
    versionCode: z.number().int().positive(),
    minSdk: z.number().int().positive().optional(),
    notes: z.array(z.string().trim().min(1).max(200)).max(3).optional(),
    builtAt: z.string().optional(),
});

/** The sidecar beside an APK: the same name with .json. */
const sidecarOf = (apk: string) => path.join(path.dirname(apk), `${path.basename(apk, path.extname(apk))}.json`);

const measured = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

/** The file's size and SHA-256, read again only when the file changed. */
async function measure(file: string): Promise<{ size: number; sha256: string } | null> {
    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(file);
    } catch {
        return null;
    }
    if (!stat.isFile()) return null;
    const known = measured.get(file);
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known;
    const sha256 = crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, sha256 };
    measured.set(file, entry);
    return entry;
}

/** The release of the app (or the QA app) this server holds, or null: no file, or no readable sidecar beside it. */
export async function phoneRelease(build: PhoneBuild): Promise<PhoneRelease | null> {
    const apk = build === 'qa' ? qaApkPath() : phoneApkPath();
    const file = await measure(apk);
    if (!file) return null;
    let raw: unknown;
    try {
        raw = JSON.parse(await fs.promises.readFile(sidecarOf(apk), 'utf8'));
    } catch {
        return null;
    }
    const info = SIDECAR.safeParse(raw);
    if (!info.success) return null;
    return {
        package: info.data.package,
        version: info.data.version,
        versionCode: info.data.versionCode,
        minSdk: info.data.minSdk ?? null,
        notes: info.data.notes ?? [],
        size: file.size,
        sha256: file.sha256,
        url: build === 'qa' ? '/phone/kaaga-qa.apk' : '/phone/kaaga.apk',
        builtAt: info.data.builtAt ?? null,
    };
}
