// One-time passwords (signup + password reset).
//
// Mongo deleted OTPs with a TTL index 180 s after creation, and verify never checked the age.
// Postgres has no TTL, so: verifyOtp() rejects (and deletes) OTPs older than 180 s, and
// startOtpCleanupCron() removes expired rows every few minutes.
import crypto from 'crypto';
import cron from 'node-cron';
import type { Otp, OtpPurpose } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { sendOtpEmail } from '../../utils/otpEmailTemplate';

export const OTP_TTL_SECONDS = 180;
const OTP_TTL_MS = OTP_TTL_SECONDS * 1000;

/** Purpose names used by the API and the old model. */
export type OtpPurposeName = 'signup' | 'password-reset';

/** Data kept with a signup OTP until it is verified. The password is already hashed. */
export interface SignupOtpData {
    name: string;
    passwordHash: string;
}

export const OTP_EXPIRED_MESSAGE = 'OTP has expired or does not exist. Please request a new one.';
export const OTP_INVALID_MESSAGE = 'Invalid OTP. Please check and try again.';

function toDbPurpose(purpose: OtpPurposeName): OtpPurpose {
    return purpose === 'password-reset' ? 'password_reset' : 'signup';
}

/** 4-digit code, 1000-9999 (same format as before, from a CSPRNG). */
export function generateOtpCode(): string {
    return crypto.randomInt(1000, 10000).toString();
}

/** An OTP expires OTP_TTL_SECONDS after it was created. */
export function isOtpExpired(createdAt: Date, now: Date = new Date()): boolean {
    return now.getTime() - createdAt.getTime() >= OTP_TTL_MS;
}

/** Read signupData back from the Json column (null if absent or malformed). */
export function readSignupData(value: unknown): SignupOtpData | null {
    if (!value || typeof value !== 'object') return null;
    const { name, passwordHash } = value as Record<string, unknown>;
    if (typeof name !== 'string' || typeof passwordHash !== 'string') return null;
    return { name, passwordHash };
}

/**
 * Replace any OTP for this email with a new one and email it.
 * Returns false when the email could not be sent (callers answer 500), as before.
 */
export async function createAndSendOtp(
    email: string,
    purpose: OtpPurposeName,
    signupData?: SignupOtpData,
    db: DbClient = prisma
): Promise<boolean> {
    const normalizedEmail = email.toLowerCase();
    const code = generateOtpCode();

    await db.otp.deleteMany({ where: { email: normalizedEmail } });
    await db.otp.create({
        data: {
            email: normalizedEmail,
            otp: code,
            purpose: toDbPurpose(purpose),
            ...(signupData ? { signupData: { name: signupData.name, passwordHash: signupData.passwordHash } } : {}),
        },
    });

    return sendOtpEmail(email, code);
}

/**
 * Check a code. Throws 400 with the old messages when there is no OTP, it expired (it is then
 * deleted) or the code is wrong. Without `purpose`, any purpose matches (POST /otp/verify).
 */
export async function verifyOtp(
    email: string,
    code: string,
    purpose?: OtpPurposeName,
    db: DbClient = prisma
): Promise<Otp> {
    const stored = await db.otp.findFirst({
        where: { email: email.toLowerCase(), ...(purpose ? { purpose: toDbPurpose(purpose) } : {}) },
        orderBy: { createdAt: 'desc' },
    });

    if (!stored) {
        throw new ErrorResponse(400, OTP_EXPIRED_MESSAGE);
    }
    if (isOtpExpired(stored.createdAt)) {
        await db.otp.deleteMany({ where: { id: stored.id } });
        throw new ErrorResponse(400, OTP_EXPIRED_MESSAGE);
    }
    if (stored.otp !== code) {
        throw new ErrorResponse(400, OTP_INVALID_MESSAGE);
    }
    return stored;
}

export async function deleteOtp(id: string, db: DbClient = prisma): Promise<void> {
    await db.otp.deleteMany({ where: { id } });
}

/** Delete every expired OTP; returns how many were removed. */
export async function deleteExpiredOtps(now: Date = new Date(), db: DbClient = prisma): Promise<number> {
    const { count } = await db.otp.deleteMany({
        where: { createdAt: { lte: new Date(now.getTime() - OTP_TTL_MS) } },
    });
    return count;
}

/** Started by src/index.ts (not by the app, so tests never schedule it). */
export function startOtpCleanupCron() {
    const task = cron.schedule('*/5 * * * *', async () => {
        try {
            const removed = await deleteExpiredOtps();
            if (removed > 0) console.log(`🧹 Removed ${removed} expired OTP(s)`);
        } catch (err) {
            console.error('OTP cleanup failed:', err);
        }
    });
    console.log('✓ OTP cleanup scheduled every 5 minutes.');
    return task;
}
