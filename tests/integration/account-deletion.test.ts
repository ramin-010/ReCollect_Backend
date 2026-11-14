// DELETE /api/account and workspace ownership: deleting a user cascades to the workspaces they own,
// so it is refused (409) while one of those workspaces has other members.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { deleteUser } from '../../src/services/users/users.service';
import { authCookie, createTestUser, TEST_PASSWORD } from '../helpers/auth';
import { createTestWorkspace, createWorkspaceTodoRow } from '../helpers/workspaces';

const BLOCKED = 'Transfer ownership or remove other members before deleting your account';

describe('DELETE /api/account with owned workspaces', () => {
    it('409 while an owned workspace has other members; nothing is deleted', async () => {
        const owner = await createTestUser();
        const member = await createTestUser();
        const shared = await createTestWorkspace(owner, { members: [{ user: member, role: 'member' }] });
        const task = await createWorkspaceTodoRow(shared, member, { title: "Member's task" });

        const res = await request(app).delete('/api/account').set('Cookie', authCookie(owner)).send({ password: TEST_PASSWORD });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ message: BLOCKED });

        expect(await prisma.user.findUnique({ where: { id: owner.id } })).not.toBeNull();
        expect(await prisma.workspace.findUnique({ where: { id: shared.id } })).not.toBeNull();
        expect(await prisma.todo.findUnique({ where: { id: task.id } })).not.toBeNull();
    });

    it('a viewer counts as another member too', async () => {
        const owner = await createTestUser();
        const viewer = await createTestUser();
        await createTestWorkspace(owner, { members: [{ user: viewer, role: 'viewer' }] });
        const res = await request(app).delete('/api/account').set('Cookie', authCookie(owner)).send({ password: TEST_PASSWORD });
        expect(res.status).toBe(409);
    });

    it('the password is still checked first (401), before the ownership rule', async () => {
        const owner = await createTestUser();
        await createTestWorkspace(owner, { members: [{ user: await createTestUser(), role: 'admin' }] });
        const res = await request(app).delete('/api/account').set('Cookie', authCookie(owner)).send({ password: 'wrong-password' });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ message: 'Invalid password' });
    });

    it('sole-member workspaces still cascade with the account', async () => {
        const owner = await createTestUser();
        const solo = await createTestWorkspace(owner);
        const task = await createWorkspaceTodoRow(solo, owner);

        const res = await request(app).delete('/api/account').set('Cookie', authCookie(owner)).send({ password: TEST_PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Account deleted successfully' });
        expect(await prisma.user.findUnique({ where: { id: owner.id } })).toBeNull();
        expect(await prisma.workspace.findUnique({ where: { id: solo.id } })).toBeNull();
        expect(await prisma.todo.findUnique({ where: { id: task.id } })).toBeNull();
    });

    it('works again once the other members are removed; being a MEMBER of someone else\'s workspace never blocks', async () => {
        const owner = await createTestUser();
        const member = await createTestUser();
        const shared = await createTestWorkspace(owner, { members: [{ user: member, role: 'member' }] });

        // The member can always delete their own account (they own nothing).
        const memberRes = await request(app).delete('/api/account').set('Cookie', authCookie(member)).send({ password: TEST_PASSWORD });
        expect(memberRes.status).toBe(200);
        expect(await prisma.workspaceMember.count({ where: { workspaceId: shared.id } })).toBe(1);

        // Now the owner is the only member left.
        const ownerRes = await request(app).delete('/api/account').set('Cookie', authCookie(owner)).send({ password: TEST_PASSWORD });
        expect(ownerRes.status).toBe(200);
        expect(await prisma.workspace.findUnique({ where: { id: shared.id } })).toBeNull();
    });

    it('deleteUser: false for an unknown user, 409 error object for a blocked one', async () => {
        expect(await deleteUser('no-such-user')).toBe(false);
        const owner = await createTestUser();
        await createTestWorkspace(owner, { members: [{ user: await createTestUser(), role: 'viewer' }] });
        await expect(deleteUser(owner.id)).rejects.toMatchObject({ statusCode: 409, message: BLOCKED });
    });
});
