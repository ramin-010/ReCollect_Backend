// User profile/settings/search endpoints and the reusable placeholder-user service.
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The avatar upload middleware (upfly → Cloudinary) is replaced by a fake that "uploads" instantly,
// and deleting the previous image from Cloudinary is a spy. Nothing leaves the machine.
vi.mock('upfly', () => ({
    upflyUpload: () => (req: any, _res: any, next: any) => {
        req.files = {
            avatar: [
                {
                    fieldname: 'avatar',
                    originalname: 'me.png',
                    cloudUrl: 'https://cdn.example.test/recollect/avatars/new.webp',
                    cloudPublicId: 'recollect/avatars/new',
                    cloudProvider: 'cloudinary',
                },
            ],
        };
        next();
    },
}));
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
}));

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { deleteFromCloud } from '../../src/utils/cloudinary';
import { createPlaceholderUser, findOrCreatePlaceholderUser } from '../../src/services/users/users.service';
import { verifyPassword } from '../../src/services/auth/password';
import { authCookie, createTestUser, TEST_PASSWORD } from '../helpers/auth';

describe('GET /api/profile', () => {
    it('returns the user without the password', async () => {
        const user = await createTestUser({ name: 'Profile Person' });
        const res = await request(app).get('/api/profile').set('Cookie', authCookie(user));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toMatchObject({ _id: user.id, name: 'Profile Person', email: user.email });
        expect(res.body.data.password).toBeUndefined();
    });

    it('401 without a cookie (user routes are behind authMiddleware)', async () => {
        const res = await request(app).get('/api/profile');
        expect(res.status).toBe(401);
    });
});

describe('PATCH /api/update-profile', () => {
    it('updates and trims the allowed fields and ignores unknown ones (bio, preferences)', async () => {
        const user = await createTestUser();
        const res = await request(app)
            .patch('/api/update-profile')
            .set('Cookie', authCookie(user))
            .send({ name: '  New Name  ', phone: ' 12345 ', reminderEmail: 'alerts@example.test', bio: 'hi', preferences: { theme: 'dark' } });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ _id: user.id, name: 'New Name', phone: '12345', reminderEmail: 'alerts@example.test' });
        expect(res.body.data.bio).toBeUndefined();
        expect(res.body.data.preferences).toBeUndefined();
    });

    it('400 "Invalid data" with zod errors', async () => {
        const user = await createTestUser();
        const res = await request(app).patch('/api/update-profile').set('Cookie', authCookie(user)).send({ email: 'nope' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe('Invalid data');
        expect(res.body.errors.fieldErrors).toHaveProperty('email');
    });

    it('rejects an email or reminder email used by another account', async () => {
        const other = await createTestUser({ email: 'other@example.test', reminderEmail: 'other-alerts@example.test' });
        const user = await createTestUser();

        const email = await request(app).patch('/api/update-profile').set('Cookie', authCookie(user)).send({ email: other.email });
        expect(email.status).toBe(400);
        expect(email.body).toEqual({ message: 'Email already in use' });

        const reminder = await request(app)
            .patch('/api/update-profile')
            .set('Cookie', authCookie(user))
            .send({ reminderEmail: 'other-alerts@example.test' });
        expect(reminder.status).toBe(400);
        expect(reminder.body).toEqual({ message: 'This alternative email is already in use by another account' });
    });

    it('allows keeping your own email', async () => {
        const user = await createTestUser();
        const res = await request(app).patch('/api/update-profile').set('Cookie', authCookie(user)).send({ email: user.email });
        expect(res.status).toBe(200);
    });
});

describe('GET /api/user/settings', () => {
    it('keeps the old shape; the cut notes lists are always empty', async () => {
        const user = await createTestUser();
        const res = await request(app).get('/api/user/settings').set('Cookie', authCookie(user));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            message: 'User settings fetched successfully',
            data: { user: { _id: user.id }, archivedNotes: [], favoriteNotes: [] },
        });
    });
});

describe('POST /api/change-password', () => {
    it('400 when the confirmation does not match', async () => {
        const user = await createTestUser();
        const res = await request(app)
            .post('/api/change-password')
            .set('Cookie', authCookie(user))
            .send({ newPassword: 'abcdefgh1', confirmPassword: 'different1' });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Invalid data');
        expect(res.body.errors.fieldErrors.confirmPassword).toEqual(["Passwords don't match"]);
    });

    it('stores a new bcrypt hash', async () => {
        const user = await createTestUser({ email: 'changer@example.test' });
        const res = await request(app)
            .post('/api/change-password')
            .set('Cookie', authCookie(user))
            .send({ newPassword: 'changed-pass', confirmPassword: 'changed-pass' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Password changed successfully' });

        const login = await request(app).post('/api/login').send({ email: 'changer@example.test', password: 'changed-pass' });
        expect(login.status).toBe(200);
    });
});

describe('DELETE /api/account', () => {
    it('requires the password', async () => {
        const user = await createTestUser();
        const missing = await request(app).delete('/api/account').set('Cookie', authCookie(user)).send({});
        expect(missing.status).toBe(400);
        expect(missing.body).toEqual({ message: 'Password required to delete account' });

        const wrong = await request(app).delete('/api/account').set('Cookie', authCookie(user)).send({ password: 'wrong-one' });
        expect(wrong.status).toBe(401);
        expect(wrong.body).toEqual({ message: 'Invalid password' });
    });

    it("deletes the user and cascades to the user's own rows", async () => {
        const user = await createTestUser();
        const doc = await prisma.doc.create({ data: { userId: user.id, title: 'Mine' } });

        const res = await request(app).delete('/api/account').set('Cookie', authCookie(user)).send({ password: TEST_PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Account deleted successfully' });
        expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
        expect(await prisma.doc.findUnique({ where: { id: doc.id } })).toBeNull();

        // The old cookie now points at nobody.
        const me = await request(app).get('/api/get-me').set('Cookie', authCookie(user));
        expect(me.status).toBe(404);
        expect(me.body).toEqual({ message: 'User not found' });
    });
});

describe('GET /api/search (assignee picker)', () => {
    it('matches name or email case-insensitively, never returns the caller or ghost users', async () => {
        const me = await createTestUser({ name: 'Searcher Smith', email: 'searcher@example.test' });
        await createTestUser({ name: 'Alice Smith', email: 'alice@example.test' });
        await createTestUser({ name: 'Bob', email: 'bob.smith@example.test' });
        await createPlaceholderUser('smith.ghost@example.test');

        const res = await request(app).get('/api/search').query({ q: 'SMITH' }).set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const emails = res.body.data.map((u: any) => u.email).sort();
        expect(emails).toEqual(['alice@example.test', 'bob.smith@example.test']);
        for (const u of res.body.data) {
            expect(Object.keys(u).sort()).toEqual(['_id', 'avatar', 'email', 'name']);
        }
    });

    it('treats % and _ literally (the old RegExp was not escaped)', async () => {
        const me = await createTestUser();
        await createTestUser({ name: 'under_score', email: 'u1@example.test' });
        await createTestUser({ name: 'underXscore', email: 'u2@example.test' });

        const underscore = await request(app).get('/api/search').query({ q: 'under_s' }).set('Cookie', authCookie(me));
        expect(underscore.body.data.map((u: any) => u.name)).toEqual(['under_score']);

        const percent = await request(app).get('/api/search').query({ q: '%%' }).set('Cookie', authCookie(me));
        expect(percent.body.data).toEqual([]);
    });

    it('returns [] for queries shorter than 2 characters and at most 10 results', async () => {
        const me = await createTestUser();
        const short = await request(app).get('/api/search').query({ q: ' a ' }).set('Cookie', authCookie(me));
        expect(short.body).toEqual({ success: true, data: [] });

        for (let i = 0; i < 12; i += 1) await createTestUser({ name: `Many ${i}`, email: `many${i}@example.test` });
        const many = await request(app).get('/api/search').query({ q: 'many' }).set('Cookie', authCookie(me));
        expect(many.body.data).toHaveLength(10);
    });
});

describe('POST /api/avatar', () => {
    it('stores the uploaded image and deletes the previous one from Cloudinary', async () => {
        const user = await createTestUser();
        await prisma.user.update({
            where: { id: user.id },
            data: { avatar: 'https://cdn.example.test/old.webp', cloudPublicId: 'recollect/avatars/old', cloudProvider: 'cloudinary' },
        });

        const res = await request(app).post('/api/avatar').set('Cookie', authCookie(user));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, data: { avatar: 'https://cdn.example.test/recollect/avatars/new.webp' } });
        expect(vi.mocked(deleteFromCloud)).toHaveBeenCalledWith('recollect/avatars/old');

        const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect(row).toMatchObject({ avatar: 'https://cdn.example.test/recollect/avatars/new.webp', cloudPublicId: 'recollect/avatars/new' });
    });
});

describe('users service: placeholder ("ghost") users', () => {
    it('createPlaceholderUser makes a pending ghost with a lowercased email and an unusable hashed password', async () => {
        const ghost = await createPlaceholderUser('  New.Person@Example.TEST ');
        expect(ghost).toMatchObject({ email: 'new.person@example.test', name: 'new.person', isGhost: true, status: 'pending' });
        const row = await prisma.user.findUniqueOrThrow({ where: { id: ghost.id }, omit: { password: false } });
        expect(row.password).toMatch(/^\$2[aby]\$/);
        expect(await verifyPassword('', row.password)).toBe(false);
    });

    it('findOrCreatePlaceholderUser returns the existing user the second time', async () => {
        const first = await findOrCreatePlaceholderUser('repeat@example.test');
        const second = await findOrCreatePlaceholderUser('REPEAT@example.test');
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.user.id).toBe(first.user.id);
    });

    it('works inside a transaction (pass the tx client)', async () => {
        const result = await prisma.$transaction(async (tx) => findOrCreatePlaceholderUser('in-tx@example.test', tx));
        expect(result.created).toBe(true);
        expect(await prisma.user.count({ where: { email: 'in-tx@example.test' } })).toBe(1);
    });
});
