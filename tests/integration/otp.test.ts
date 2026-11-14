// /api/otp/* endpoints and the OTP expiry/cleanup that replaced Mongo's TTL index.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { deleteExpiredOtps, OTP_TTL_SECONDS } from '../../src/services/auth/otp.service';
import { authCookie, createTestUser } from '../helpers/auth';
import { lastOtpSentTo, mailsTo, setMailFailure } from '../helpers/mail';

describe('POST /api/otp/generate', () => {
    it('stores a 4-digit signup OTP (lowercased email) and emails it', async () => {
        const res = await request(app).post('/api/otp/generate').send({ email: 'Someone@Example.test' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'OTP sent successfully to your email' });

        const stored = await prisma.otp.findFirstOrThrow({ where: { email: 'someone@example.test' } });
        expect(stored.purpose).toBe('signup');
        expect(stored.otp).toMatch(/^\d{4}$/);
        expect(lastOtpSentTo('Someone@Example.test')).toBe(stored.otp);
    });

    it('replaces the previous OTP for the same email', async () => {
        await request(app).post('/api/otp/generate').send({ email: 'twice@example.test' });
        await request(app).post('/api/otp/generate').send({ email: 'twice@example.test' });
        expect(await prisma.otp.count({ where: { email: 'twice@example.test' } })).toBe(1);
        expect(mailsTo('twice@example.test')).toHaveLength(2);
    });

    it('400 for an invalid email, 500 when sending fails', async () => {
        const bad = await request(app).post('/api/otp/generate').send({ email: 'not-an-email' });
        expect(bad.status).toBe(400);
        expect(bad.body.success).toBe(false);
        expect(bad.body.message).toBe('Invalid request');

        setMailFailure(true);
        const failed = await request(app).post('/api/otp/generate').send({ email: 'down@example.test' });
        setMailFailure(false);
        expect(failed.status).toBe(500);
        expect(failed.body).toEqual({ message: 'Failed to send OTP email. Please try again.' });
    });
});

describe('POST /api/otp/verify', () => {
    it('accepts the right code once and deletes it', async () => {
        await request(app).post('/api/otp/generate').send({ email: 'verify@example.test' });
        const code = lastOtpSentTo('verify@example.test')!;

        const ok = await request(app).post('/api/otp/verify').send({ email: 'VERIFY@example.test', otp: code });
        expect(ok.status).toBe(200);
        expect(ok.body).toEqual({ success: true, message: 'OTP verified successfully' });

        const again = await request(app).post('/api/otp/verify').send({ email: 'verify@example.test', otp: code });
        expect(again.status).toBe(400);
        expect(again.body.message).toBe('OTP has expired or does not exist. Please request a new one.');
    });

    it('400 for a wrong code', async () => {
        await request(app).post('/api/otp/generate').send({ email: 'wrongcode@example.test' });
        const code = lastOtpSentTo('wrongcode@example.test')!;
        const res = await request(app)
            .post('/api/otp/verify')
            .send({ email: 'wrongcode@example.test', otp: code === '9999' ? '1000' : '9999' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'Invalid OTP. Please check and try again.' });
    });

    it(`rejects a code older than ${OTP_TTL_SECONDS} s`, async () => {
        await request(app).post('/api/otp/generate').send({ email: 'old@example.test' });
        const code = lastOtpSentTo('old@example.test')!;
        await prisma.otp.updateMany({
            where: { email: 'old@example.test' },
            data: { createdAt: new Date(Date.now() - (OTP_TTL_SECONDS + 1) * 1000) },
        });

        const res = await request(app).post('/api/otp/verify').send({ email: 'old@example.test', otp: code });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('OTP has expired or does not exist. Please request a new one.');
        expect(await prisma.otp.count({ where: { email: 'old@example.test' } })).toBe(0);
    });

    it('400 "Invalid request" when the code is not 4 characters', async () => {
        const res = await request(app).post('/api/otp/verify').send({ email: 'x@example.test', otp: '12' });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Invalid request');
        expect(res.body.error.fieldErrors.otp).toEqual(['OTP must be exactly 4 digits']);
    });
});

describe('POST /api/otp/generate-auth (logged in)', () => {
    it('401 without a cookie', async () => {
        const res = await request(app).post('/api/otp/generate-auth');
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ message: 'Not authorized, no token found' });
    });

    it("sends a password-reset OTP to the user's own email", async () => {
        const user = await createTestUser({ email: 'me@example.test' });
        const res = await request(app).post('/api/otp/generate-auth').set('Cookie', authCookie(user));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'OTP sent successfully to your registered email' });
        const stored = await prisma.otp.findFirstOrThrow({ where: { email: 'me@example.test' } });
        expect(stored.purpose).toBe('password_reset');
        expect(lastOtpSentTo('me@example.test')).toBe(stored.otp);
    });
});

describe('POST /api/otp/generate-for-email (logged in)', () => {
    it('sends a code to another address (stored lowercased, message keeps the typed case)', async () => {
        const user = await createTestUser();
        const res = await request(app)
            .post('/api/otp/generate-for-email')
            .set('Cookie', authCookie(user))
            .send({ email: 'Alt.Address@Example.test' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'OTP sent successfully to Alt.Address@Example.test' });
        expect(await prisma.otp.count({ where: { email: 'alt.address@example.test', purpose: 'password_reset' } })).toBe(1);
    });

    it('400 without an email', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/otp/generate-for-email').set('Cookie', authCookie(user)).send({});
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'Please provide a valid email address' });
    });
});

describe('expired OTP cleanup (replaces the Mongo TTL index)', () => {
    it('deleteExpiredOtps removes only rows older than the TTL', async () => {
        const now = Date.now();
        await prisma.otp.createMany({
            data: [
                { email: 'fresh@example.test', otp: '1111', createdAt: new Date(now - 10_000) },
                { email: 'stale@example.test', otp: '2222', createdAt: new Date(now - (OTP_TTL_SECONDS + 5) * 1000) },
            ],
        });
        const removed = await deleteExpiredOtps(new Date(now));
        expect(removed).toBe(1);
        expect(await prisma.otp.count({ where: { email: 'fresh@example.test' } })).toBe(1);
        expect(await prisma.otp.count({ where: { email: 'stale@example.test' } })).toBe(0);
    });
});
