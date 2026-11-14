// POST /api/auth/google. Only the network check (verifyGoogleIdentity) is replaced; by default
// the spy calls the real function, so input validation still runs for real.
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/auth/google.service', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../src/services/auth/google.service')>();
    return { ...real, verifyGoogleIdentity: vi.fn(real.verifyGoogleIdentity) };
});

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { verifyGoogleIdentity } from '../../src/services/auth/google.service';
import { createPlaceholderUser } from '../../src/services/users/users.service';
import { cookiesFrom, createTestUser } from '../helpers/auth';

const googleSaysItIs = (identity: { email: string; name?: string; googleId?: string; picture?: string }) =>
    vi.mocked(verifyGoogleIdentity).mockResolvedValueOnce({
        email: identity.email,
        name: identity.name ?? 'Google Person',
        googleId: identity.googleId ?? 'google-sub-123',
        picture: identity.picture,
    });

describe('POST /api/auth/google', () => {
    it('400 without a credential or access token', async () => {
        const res = await request(app).post('/api/auth/google').send({});
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'Google credential token or access token is required' });
    });

    it('creates a Google user on first login and sets the auth cookies', async () => {
        googleSaysItIs({ email: 'New.Google@Example.test', name: 'New Google', googleId: 'sub-new', picture: 'https://pics.example.test/p.png' });
        const res = await request(app).post('/api/auth/google').send({ accessToken: 'fake' });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            email: 'new.google@example.test',
            name: 'New Google',
            googleId: 'sub-new',
            authProvider: 'google',
            avatar: 'https://pics.example.test/p.png',
        });
        expect(cookiesFrom(res.headers['set-cookie'] as unknown as string[]).token).toBeTruthy();
        // The frontend detects "new user" from createdAt.
        expect(Date.now() - new Date(res.body.data.createdAt).getTime()).toBeLessThan(60_000);

        const row = await prisma.user.findUniqueOrThrow({ where: { email: 'new.google@example.test' }, omit: { password: false } });
        expect(row.password).toMatch(/^\$2[aby]\$/); // placeholder password, hashed and unusable
    });

    it('links Google to an existing password account with the same (lowercased) email', async () => {
        const user = await createTestUser({ email: 'linkme@example.test' });
        googleSaysItIs({ email: 'LinkMe@Example.test', googleId: 'sub-link', picture: 'https://pics.example.test/l.png' });

        const res = await request(app).post('/api/auth/google').send({ credential: 'fake-id-token' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ _id: user.id, googleId: 'sub-link', authProvider: 'google', avatar: 'https://pics.example.test/l.png' });
    });

    it('claims a placeholder (ghost) user', async () => {
        const ghost = await createPlaceholderUser('ghosted@example.test');
        googleSaysItIs({ email: 'ghosted@example.test', googleId: 'sub-ghost' });

        const res = await request(app).post('/api/auth/google').send({ accessToken: 'fake' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ _id: ghost.id, isGhost: false, status: 'active', googleId: 'sub-ghost' });
    });

    it('changes nothing for a user who is already linked', async () => {
        const user = await createTestUser({ email: 'linked@example.test', googleId: 'sub-old', authProvider: 'google', avatar: 'mine.png' });
        googleSaysItIs({ email: 'linked@example.test', googleId: 'sub-old', picture: 'https://pics.example.test/other.png' });

        const res = await request(app).post('/api/auth/google').send({ accessToken: 'fake' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ _id: user.id, avatar: 'mine.png' });
        expect(new Date(res.body.data.updatedAt).getTime()).toBe(user.updatedAt.getTime());
    });
});
