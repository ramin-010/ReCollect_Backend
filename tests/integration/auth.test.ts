// Auth endpoints on Postgres: same routes, status codes, messages and JSON shapes as the Mongo version.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { verifyPassword } from '../../src/services/auth/password';
import { createPlaceholderUser } from '../../src/services/users/users.service';
import { authCookie, cookiesFrom, createTestUser, TEST_PASSWORD } from '../helpers/auth';
import { lastOtpSentTo, mailsTo, setMailFailure } from '../helpers/mail';

const USER_KEYS = [
    '_id', 'authProvider', 'avatar', 'cloudProvider', 'cloudPublicId', 'createdAt', 'email', 'googleId',
    'isGhost', 'name', 'phone', 'reminderEmail', 'status', 'updatedAt',
].sort();

function setCookieHeader(res: request.Response): string[] {
    const raw = res.headers['set-cookie'] as unknown;
    return Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
}

async function ageOtp(email: string, seconds: number) {
    const otp = await prisma.otp.findFirstOrThrow({ where: { email: email.toLowerCase() } });
    await prisma.otp.update({ where: { id: otp.id }, data: { createdAt: new Date(Date.now() - seconds * 1000) } });
}

describe('POST /api/signup', () => {
    it('creates the user, sets the auth cookies and returns the user without the password', async () => {
        const res = await request(app)
            .post('/api/signup')
            .send({ name: '  Ada Lovelace ', email: 'Ada@Example.test', password: 'secret-pass' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Object.keys(res.body.data).sort()).toEqual(USER_KEYS);
        expect(res.body.data).toMatchObject({
            name: 'Ada Lovelace', // trimmed, as Mongoose did
            email: 'Ada@Example.test', // used exactly as typed on this route, as before
            reminderEmail: 'Ada@Example.test', // defaults to the email (old pre-save hook)
            status: 'active',
            isGhost: false,
            authProvider: 'local',
            avatar: '',
            phone: '',
        });
        expect(res.body.data.password).toBeUndefined();

        const cookies = cookiesFrom(setCookieHeader(res));
        expect(cookies.auth_hint).toBe('1');
        const payload = jwt.verify(cookies.token!, process.env.JWT_SECRET!) as { id: string };
        expect(payload.id).toBe(res.body.data._id);
        expect(setCookieHeader(res).find((c) => c.startsWith('token='))).toMatch(/HttpOnly/i);

        const row = await prisma.user.findUniqueOrThrow({ where: { id: res.body.data._id }, omit: { password: false } });
        expect(row.password).toMatch(/^\$2[aby]\$/);
        expect(await verifyPassword('secret-pass', row.password)).toBe(true);
    });

    it('rejects an existing email with 400 "User already exists"', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/signup').send({ name: 'X', email: user.email, password: 'secret-pass' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'User already exists' });
    });

    it('validates input with the old message', async () => {
        const res = await request(app).post('/api/signup').send({ name: '', email: 'nope', password: 'short' });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Invalid Credential');
        expect(res.body.error.fieldErrors).toHaveProperty('email');
        expect(res.body.error.fieldErrors).toHaveProperty('password');
    });

    it('enforces the 50-character name limit like the Mongoose schema', async () => {
        const res = await request(app).post('/api/signup').send({ name: 'n'.repeat(51), email: 'long@example.test', password: 'secret-pass' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/^Path `name` \(`n+`\) is longer than the maximum allowed length \(50\)\.$/);
    });
});

describe('POST /api/login', () => {
    it('logs in and the returned cookie authenticates later requests', async () => {
        const user = await createTestUser({ email: 'login@example.test' });
        const agent = request.agent(app);

        const res = await agent.post('/api/login').send({ email: 'login@example.test', password: TEST_PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, data: { _id: user.id, email: 'login@example.test' } });
        expect(res.body.data.password).toBeUndefined();
        expect(cookiesFrom(setCookieHeader(res)).auth_hint).toBe('1');

        const me = await agent.get('/api/get-me');
        expect(me.status).toBe(200);
        expect(me.body.data.user._id).toBe(user.id);
    });

    it('answers 400 "wrong password" and 400 "user does not exist"', async () => {
        await createTestUser({ email: 'login2@example.test' });

        const wrong = await request(app).post('/api/login').send({ email: 'login2@example.test', password: 'not-the-password' });
        expect(wrong.status).toBe(400);
        expect(wrong.body).toEqual({ message: 'wrong password' });

        const missing = await request(app).post('/api/login').send({ email: 'nobody@example.test', password: 'whatever1' });
        expect(missing.status).toBe(400);
        expect(missing.body).toEqual({ message: 'user does not exist' });
    });

    it('matches the email exactly (case-sensitive), as the Mongo query did', async () => {
        await createTestUser({ email: 'case@example.test' });
        const res = await request(app).post('/api/login').send({ email: 'CASE@example.test', password: TEST_PASSWORD });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('user does not exist');
    });

    it('validates input with the old (misspelled) message', async () => {
        const res = await request(app).post('/api/login').send({ email: 'bad', password: '1' });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Invalid credentails');
    });
});

describe('GET /api/get-me (auth middleware)', () => {
    it('returns { dashboards: [], user } for the cookie user', async () => {
        const user = await createTestUser();
        const res = await request(app).get('/api/get-me').set('Cookie', authCookie(user));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toBe('get me succeded');
        expect(res.body.data.dashboards).toEqual([]);
        expect(Object.keys(res.body.data.user).sort()).toEqual(USER_KEYS);
        expect(res.body.data.user._id).toBe(user.id);
    });

    it('401 without a cookie', async () => {
        const res = await request(app).get('/api/get-me');
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ message: 'Not authorized, no token found' });
    });

    it('404 "Invalid token" for a malformed or foreign token', async () => {
        const garbage = await request(app).get('/api/get-me').set('Cookie', ['token=not-a-jwt']);
        expect(garbage.status).toBe(404);
        expect(garbage.body).toEqual({ message: 'Invalid token' });

        const foreign = jwt.sign({ id: 'someone' }, 'another-secret');
        const res = await request(app).get('/api/get-me').set('Cookie', [`token=${foreign}`]);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ message: 'Invalid token' });
    });

    it('404 "User not found" for a valid token of an unknown user (e.g. an old Mongo id)', async () => {
        const res = await request(app).get('/api/get-me').set('Cookie', authCookie({ id: '64b7f0c2a1b2c3d4e5f60718' }));
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ message: 'User not found' });
    });

    it('401 for an expired token (it used to pass through without req.user)', async () => {
        const user = await createTestUser();
        const expired = jwt.sign({ id: user.id, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET!);
        const res = await request(app).get('/api/get-me').set('Cookie', [`token=${expired}`]);
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ message: 'Not authorized, token expired' });
    });
});

describe('POST /api/logout', () => {
    it('clears both cookies', async () => {
        const res = await request(app).post('/api/logout');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Logged out successfully' });
        const header = setCookieHeader(res);
        expect(header.find((c) => c.startsWith('token=;'))).toMatch(/Expires=Thu, 01 Jan 1970/);
        expect(header.find((c) => c.startsWith('auth_hint=;'))).toMatch(/Expires=Thu, 01 Jan 1970/);
    });
});

describe('OTP signup: POST /api/pre-signup → POST /api/verify-signup', () => {
    it('emails a code, stores it lowercased with a HASHED password, then creates the user (201)', async () => {
        const pre = await request(app)
            .post('/api/pre-signup')
            .send({ name: 'Grace', email: 'Grace@Example.test', password: 'grace-secret' });
        expect(pre.status).toBe(200);
        expect(pre.body).toEqual({ success: true, message: 'OTP sent successfully to your email. Please verify to complete signup.' });

        const code = lastOtpSentTo('Grace@Example.test');
        expect(code).toMatch(/^\d{6}$/);
        const stored = await prisma.otp.findFirstOrThrow({ where: { email: 'grace@example.test' } });
        expect(stored.otp).toBe(code);
        expect(stored.purpose).toBe('signup');
        const signupData = stored.signupData as { name: string; passwordHash: string; password?: string };
        expect(signupData.name).toBe('Grace');
        expect(signupData.password).toBeUndefined();
        expect(await verifyPassword('grace-secret', signupData.passwordHash)).toBe(true);

        const verify = await request(app).post('/api/verify-signup').send({ email: 'Grace@Example.test', otp: code });
        expect(verify.status).toBe(201);
        expect(verify.body).toMatchObject({ success: true, data: { name: 'Grace', email: 'grace@example.test', isGhost: false } });
        expect(cookiesFrom(setCookieHeader(verify)).token).toBeTruthy();
        expect(await prisma.otp.count({ where: { email: 'grace@example.test' } })).toBe(0);

        const login = await request(app).post('/api/login').send({ email: 'grace@example.test', password: 'grace-secret' });
        expect(login.status).toBe(200);
    });

    it('400 when the email is already registered', async () => {
        await createTestUser({ email: 'taken@example.test' });
        const res = await request(app).post('/api/pre-signup').send({ name: 'T', email: 'TAKEN@example.test', password: 'secret-pass' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ success: false, message: 'Email already registered. Please login instead.' });
    });

    it('500 when the email cannot be sent', async () => {
        setMailFailure(true);
        const res = await request(app).post('/api/pre-signup').send({ name: 'M', email: 'mailfail@example.test', password: 'secret-pass' });
        setMailFailure(false);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ success: false, message: 'Failed to send OTP email. Please try again.' });
    });

    it('400 for a wrong code (the OTP stays usable)', async () => {
        await request(app).post('/api/pre-signup').send({ name: 'W', email: 'wrong@example.test', password: 'secret-pass' });
        const code = lastOtpSentTo('wrong@example.test')!;
        const wrongCode = code === '123456' ? '654321' : '123456';

        const res = await request(app).post('/api/verify-signup').send({ email: 'wrong@example.test', otp: wrongCode });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'Invalid OTP. Please check and try again.' });
        expect(await prisma.otp.count({ where: { email: 'wrong@example.test' } })).toBe(1);
    });

    it('rejects and deletes an OTP older than 180 seconds', async () => {
        await request(app).post('/api/pre-signup').send({ name: 'E', email: 'expired@example.test', password: 'secret-pass' });
        const code = lastOtpSentTo('expired@example.test')!;
        await ageOtp('expired@example.test', 181);

        const res = await request(app).post('/api/verify-signup').send({ email: 'expired@example.test', otp: code });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'OTP has expired or does not exist. Please request a new one.' });
        expect(await prisma.otp.count({ where: { email: 'expired@example.test' } })).toBe(0);
        expect(await prisma.user.count({ where: { email: 'expired@example.test' } })).toBe(0);
    });

    it('still accepts an OTP just inside the 180-second window', async () => {
        await request(app).post('/api/pre-signup').send({ name: 'J', email: 'justintime@example.test', password: 'secret-pass' });
        const code = lastOtpSentTo('justintime@example.test')!;
        await ageOtp('justintime@example.test', 170);

        const res = await request(app).post('/api/verify-signup').send({ email: 'justintime@example.test', otp: code });
        expect(res.status).toBe(201);
    });

    it('400 when no OTP exists', async () => {
        const res = await request(app).post('/api/verify-signup').send({ email: 'never@example.test', otp: '123456' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'OTP has expired or does not exist. Please request a new one.' });
    });

    it('400 "Signup data not found" when the signup OTP carries no signup data', async () => {
        await request(app).post('/api/otp/generate').send({ email: 'nodata@example.test' });
        const code = lastOtpSentTo('nodata@example.test')!;
        const res = await request(app).post('/api/verify-signup').send({ email: 'nodata@example.test', otp: code });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ success: false, message: 'Signup data not found. Please start the signup process again.' });
    });

    it('claims a placeholder (ghost) user instead of creating a second account', async () => {
        const ghost = await createPlaceholderUser('Invited@Example.test');
        expect(ghost).toMatchObject({ isGhost: true, status: 'pending', email: 'invited@example.test' });

        // Deliberate fix: the Mongo version answered 400 "Email already registered" here.
        const pre = await request(app)
            .post('/api/pre-signup')
            .send({ name: 'Invited Person', email: 'invited@example.test', password: 'secret-pass' });
        expect(pre.status).toBe(200);
        const code = lastOtpSentTo('invited@example.test')!;
        const res = await request(app).post('/api/verify-signup').send({ email: 'invited@example.test', otp: code });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ _id: ghost.id, name: 'Invited Person', isGhost: false, status: 'active' });
        expect(await prisma.user.count({ where: { email: 'invited@example.test' } })).toBe(1);
        const login = await request(app).post('/api/login').send({ email: 'invited@example.test', password: 'secret-pass' });
        expect(login.status).toBe(200);
    });

    it('400 "User already exists" if a real account appeared between pre-signup and verify', async () => {
        await request(app).post('/api/pre-signup').send({ name: 'R', email: 'race@example.test', password: 'secret-pass' });
        const code = lastOtpSentTo('race@example.test')!;
        await createTestUser({ email: 'race@example.test' });

        const res = await request(app).post('/api/verify-signup').send({ email: 'race@example.test', otp: code });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'User already exists' });
        // The transaction rolled back, so the OTP was not consumed.
        expect(await prisma.otp.count({ where: { email: 'race@example.test' } })).toBe(1);
    });
});

describe('password reset: POST /api/forgot-password → POST /api/reset-password', () => {
    it('answers 200 with the same message for unknown emails and sends nothing', async () => {
        const res = await request(app).post('/api/forgot-password').send({ email: 'ghost-town@example.test' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'If an account exists with this email, an OTP has been sent.' });
        expect(mailsTo('ghost-town@example.test')).toHaveLength(0);
    });

    it('resets the password with the emailed code', async () => {
        await createTestUser({ email: 'reset@example.test' });

        const forgot = await request(app).post('/api/forgot-password').send({ email: 'reset@example.test' });
        expect(forgot.status).toBe(200);
        const code = lastOtpSentTo('reset@example.test')!;
        expect((await prisma.otp.findFirstOrThrow({ where: { email: 'reset@example.test' } })).purpose).toBe('password_reset');

        const reset = await request(app)
            .post('/api/reset-password')
            .send({ email: 'reset@example.test', otp: code, newPassword: 'brand-new-pass' });
        expect(reset.status).toBe(200);
        expect(reset.body).toEqual({ success: true, message: 'Password reset successful. You can now login with your new password.' });
        expect(await prisma.otp.count({ where: { email: 'reset@example.test' } })).toBe(0);

        const oldLogin = await request(app).post('/api/login').send({ email: 'reset@example.test', password: TEST_PASSWORD });
        expect(oldLogin.status).toBe(400);
        const newLogin = await request(app).post('/api/login').send({ email: 'reset@example.test', password: 'brand-new-pass' });
        expect(newLogin.status).toBe(200);
    });

    it('rejects an expired reset code', async () => {
        await createTestUser({ email: 'reset2@example.test' });
        await request(app).post('/api/forgot-password').send({ email: 'reset2@example.test' });
        const code = lastOtpSentTo('reset2@example.test')!;
        await ageOtp('reset2@example.test', 200);

        const res = await request(app)
            .post('/api/reset-password')
            .send({ email: 'reset2@example.test', otp: code, newPassword: 'brand-new-pass' });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('OTP has expired or does not exist. Please request a new one.');
    });

    it('does not accept a signup code for a password reset', async () => {
        await createTestUser({ email: 'mixup@example.test' });
        await request(app).post('/api/otp/generate').send({ email: 'mixup@example.test' }); // purpose: signup
        const code = lastOtpSentTo('mixup@example.test')!;

        const res = await request(app)
            .post('/api/reset-password')
            .send({ email: 'mixup@example.test', otp: code, newPassword: 'brand-new-pass' });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('OTP has expired or does not exist. Please request a new one.');
    });
});
