// Auth flows. Controllers validate input and shape HTTP responses; this file holds the logic.
// Error messages and status codes are the ones the Mongo version produced (some are typos on
// purpose, e.g. "user does not exist"; the frontend shows them as they are).
import crypto from 'crypto';
import { prisma, type DbClient } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { hashPassword, verifyPassword } from './password';
import { assertMayMakeAccount, useInviteFor } from '../owner/invites.service';
import { startBuddyForNewAccount } from '../buddy/state.service';
import { createAndSendOtp, deleteOtp, readSignupData, verifyOtp } from './otp.service';
import type { GoogleIdentity } from './google.service';
import {
    applyGoogleLogin,
    claimGhostUser,
    createUser,
    findUserByEmail,
    findUserByEmailWithPassword,
    setUserPassword,
    type SafeUser,
} from '../users/users.service';

/**
 * Stage 11: a new account (or a claimed placeholder) is settled: the open invite for its email is used (its allowance
 * becomes the first grant) and the buddy starts on with the loop on (the owner's word for new accounts).
 */
export async function settleNewAccount(user: Pick<SafeUser, 'id' | 'email'>, db: DbClient = prisma, now: Date = new Date()): Promise<void> {
    await useInviteFor(user.email, user.id, now, db);
    await startBuddyForNewAccount(user.id, db);
}

/** The owner ended this account's access (stage 11): no sign-in, the account kept. */
export const ACCESS_ENDED_MESSAGE = 'This account’s access has ended. Ask the person who invited you.';
const assertAccessOpen = (user: { accessEndedAt?: Date | null }) => {
    if (user.accessEndedAt) throw new ErrorResponse(403, ACCESS_ENDED_MESSAGE);
};

/** POST /signup (no OTP). The email is used exactly as typed, as before. Stage 11: with an invite, its code too. */
export async function signupWithPassword(input: { name: string; email: string; password: string; timezone?: string | undefined; invite?: string | undefined }): Promise<SafeUser> {
    // SIGNUP_MODE (hosting P1-3), or an open invite for this email whose code came with it (this route proves no address).
    await assertMayMakeAccount(input.email, { code: input.invite, needCode: true });
    const existingUser = await findUserByEmail(input.email);
    if (existingUser) {
        throw new ErrorResponse(400, 'User already exists');
    }
    // Stage 11 (§9.6): the browser's time zone, so a friend's days and reminders are their own from the first day.
    const user = await createUser({ email: input.email, name: input.name, password: input.password, ...(input.timezone ? { timezone: input.timezone } : {}) });
    await settleNewAccount(user);
    return user;
}

/** POST /login. Exact email match, as before. */
export async function loginWithPassword(input: { email: string; password: string }): Promise<SafeUser> {
    const user = await findUserByEmailWithPassword(input.email);
    if (!user) {
        throw new ErrorResponse(400, 'user does not exist');
    }
    const isMatched = await verifyPassword(input.password, user.password);
    if (!isMatched) throw new ErrorResponse(400, 'wrong password');
    assertAccessOpen(user);

    const { password: _password, ...safeUser } = user;
    return safeUser;
}

/**
 * POST /pre-signup: send a signup OTP. The password is hashed before it is stored with the OTP.
 * Placeholder (ghost) users may sign up: verify-signup then claims the account. (The Mongo
 * version rejected them here, so its claim branch was unreachable even though invite emails
 * send ghosts to /signup.)
 */
export async function startEmailSignup(input: {
    name: string;
    email: string;
    password: string;
}): Promise<'otp-sent' | 'email-taken' | 'email-failed'> {
    await assertMayMakeAccount(input.email); // a new account or a placeholder's claim (hosting P1-3), or an open invite (stage 11)
    const existingUser = await findUserByEmail(input.email.toLowerCase());
    if (existingUser && !existingUser.isGhost) return 'email-taken';

    const passwordHash = await hashPassword(input.password);
    const emailSent = await createAndSendOtp(input.email, 'signup', { name: input.name, passwordHash });
    return emailSent ? 'otp-sent' : 'email-failed';
}

/**
 * POST /verify-signup: check the OTP, then create the user, or claim a ghost user with the
 * same email (keeps its id, so existing invites/assignments stay attached).
 */
export async function completeEmailSignup(
    email: string,
    code: string
): Promise<{ status: 'created'; user: SafeUser } | { status: 'missing-signup-data' }> {
    await assertMayMakeAccount(email); // the mode (or the invite) may have changed since the code was sent (hosting P1-3)
    const storedOtp = await verifyOtp(email, code, 'signup');
    const signupData = readSignupData(storedOtp.signupData);
    if (!signupData) {
        return { status: 'missing-signup-data' };
    }

    const normalizedEmail = email.toLowerCase();
    const user = await prisma.$transaction(async (tx) => {
        const existing = await findUserByEmail(normalizedEmail, tx);
        let result: SafeUser;
        if (existing && existing.isGhost) {
            // Claim the ghost account
            result = await claimGhostUser(existing.id, signupData, tx);
            console.log(`[auth] Ghost user claimed via email signup: ${existing.id}`);
        } else if (existing) {
            throw new ErrorResponse(400, 'User already exists');
        } else {
            result = await createUser(
                { email: normalizedEmail, name: signupData.name, passwordHash: signupData.passwordHash },
                tx
            );
        }
        await deleteOtp(storedOtp.id, tx);
        await settleNewAccount(result, tx);
        return result;
    });

    return { status: 'created', user };
}

/** POST /forgot-password. */
export async function requestPasswordReset(email: string): Promise<'no-user' | 'otp-sent' | 'email-failed'> {
    const user = await findUserByEmail(email.toLowerCase());
    if (!user) return 'no-user';
    const emailSent = await createAndSendOtp(email, 'password-reset');
    return emailSent ? 'otp-sent' : 'email-failed';
}

/** POST /reset-password: OTP first (throws on a bad/expired code), then the new password. */
export async function resetPasswordWithOtp(
    email: string,
    code: string,
    newPassword: string
): Promise<'reset' | 'user-not-found'> {
    const storedOtp = await verifyOtp(email, code, 'password-reset');

    const user = await findUserByEmail(email.toLowerCase());
    if (!user) return 'user-not-found';

    await setUserPassword(user.id, newPassword);
    await deleteOtp(storedOtp.id);
    return 'reset';
}

/** POST /auth/google after the token was verified: log in, link, claim a ghost, or create. */
export async function loginWithGoogle(identity: GoogleIdentity): Promise<SafeUser> {
    const normalizedEmail = identity.email.toLowerCase();
    const existing = await findUserByEmail(normalizedEmail);

    if (existing) {
        assertAccessOpen(existing);
        if (existing.isGhost) {
            await assertMayMakeAccount(normalizedEmail); // claiming a placeholder is making an account (hosting P1-3)
            console.log(`[auth] Ghost user claimed via Google: ${existing.id}`);
            const claimed = await applyGoogleLogin(existing, { googleId: identity.googleId, picture: identity.picture });
            await settleNewAccount(claimed);
            return claimed;
        }
        return applyGoogleLogin(existing, { googleId: identity.googleId, picture: identity.picture });
    }

    // Create a new user (no password needed for Google auth)
    await assertMayMakeAccount(normalizedEmail); // SIGNUP_MODE (hosting P1-3), or an open invite (stage 11: Google proved the address)
    const user = await createUser({
        email: normalizedEmail,
        name: identity.name || 'Google User',
        googleId: identity.googleId,
        authProvider: 'google',
        avatar: identity.picture || '',
        // Placeholder, never used for login. Was google_<googleId>_<Date.now()>, which is guessable.
        password: `google_${crypto.randomBytes(18).toString('hex')}`,
    });
    await settleNewAccount(user);
    return user;
}
