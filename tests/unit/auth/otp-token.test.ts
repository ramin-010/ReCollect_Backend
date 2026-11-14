import { afterEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { generateOtpCode, isOtpExpired, OTP_TTL_SECONDS, readSignupData } from '../../../src/services/auth/otp.service';
import { authCookieOptions, signAuthToken } from '../../../src/services/auth/token';
import { hashPassword, verifyPassword } from '../../../src/services/auth/password';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('OTP rules', () => {
    it('codes are 4 digits', () => {
        for (let i = 0; i < 200; i += 1) expect(generateOtpCode()).toMatch(/^[1-9]\d{3}$/);
    });

    it(`expires exactly ${OTP_TTL_SECONDS} s after creation`, () => {
        const created = new Date('2026-10-21T10:00:00Z');
        expect(isOtpExpired(created, new Date(created.getTime() + (OTP_TTL_SECONDS - 1) * 1000))).toBe(false);
        expect(isOtpExpired(created, new Date(created.getTime() + OTP_TTL_SECONDS * 1000))).toBe(true);
    });

    it('reads signup data defensively', () => {
        expect(readSignupData({ name: 'A', passwordHash: 'h' })).toEqual({ name: 'A', passwordHash: 'h' });
        expect(readSignupData({ name: 'A', password: 'plain' })).toBeNull();
        expect(readSignupData(null)).toBeNull();
    });
});

describe('auth token + cookies', () => {
    it('signs { id } with JWT_SECRET and JWT_EXPIRE', () => {
        vi.stubEnv('JWT_SECRET', 'unit-secret');
        vi.stubEnv('JWT_EXPIRE', '2h');
        const payload = jwt.verify(signAuthToken('cuser1'), 'unit-secret') as { id: string; exp: number; iat: number };
        expect(payload.id).toBe('cuser1');
        expect(payload.exp - payload.iat).toBe(2 * 3600);
    });

    it('throws without JWT_SECRET', () => {
        vi.stubEnv('JWT_SECRET', '');
        expect(() => signAuthToken('x')).toThrow('JWT_SECRET is not defined in environment variables');
    });

    it('dev cookies: lax, not secure; production: none + secure + COOKIE_DOMAIN', () => {
        vi.stubEnv('JWT_COOKIE_EXPIRE', '30');
        vi.stubEnv('NODE_ENV', 'development');
        const dev = authCookieOptions(0);
        expect(dev.token).toMatchObject({ httpOnly: true, secure: false, sameSite: 'lax', domain: undefined });
        expect(dev.hint).toMatchObject({ httpOnly: false });
        expect(dev.token.expires?.getTime()).toBe(30 * 24 * 3600 * 1000);

        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('COOKIE_DOMAIN', '.example.test');
        expect(authCookieOptions(0).token).toMatchObject({ secure: true, sameSite: 'none', domain: '.example.test' });
    });

    it('400 when JWT_COOKIE_EXPIRE is missing (as before)', () => {
        vi.stubEnv('JWT_COOKIE_EXPIRE', '');
        expect(() => authCookieOptions()).toThrow('JWT_COOKIE_EXPIRE is undefined');
    });
});

describe('passwords', () => {
    it('hashes with bcrypt and never matches a missing hash', async () => {
        vi.stubEnv('BCRYPT_SALT_ROUNDS', '4');
        const hash = await hashPassword('s3cret-pass');
        expect(hash).toMatch(/^\$2[aby]\$04\$/);
        expect(await verifyPassword('s3cret-pass', hash)).toBe(true);
        expect(await verifyPassword('wrong', hash)).toBe(false);
        expect(await verifyPassword('anything', null)).toBe(false);
    });
});
