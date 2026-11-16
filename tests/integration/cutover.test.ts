// The cutover's clean-up (hosting review A5; scripts/lib/cutover.ts) on the test database:
// - the QA accounts go with all they own;
// - the owner gets the real address and the new password;
// - every access token is revoked, and OAuth refresh tokens, OAuth codes, push subscriptions and
//   email codes are deleted;
// - the dry run changes nothing, a second run changes nothing, and a refusal changes nothing.
// The guard on which database: tests/unit/scripts/target.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createUser } from '../../src/services/users/users.service';
import { hashPassword, verifyPassword } from '../../src/services/auth/password';
import { applyCutover, planCutover, verifyCutover } from '../../scripts/lib/cutover';
import { getTestDatabaseUrl, truncateAllTables } from '../helpers/testDb';

const REAL = 'owner.real@example.org';
const NEW_PASSWORD = 'a-long-new-password!';
const HOUR = 3_600_000;

async function seed() {
    const owner = await createUser({ email: 'dev@recollect.local', name: 'Owner', password: 'devpass123' });
    const qa = await createUser({ email: 'qa@recollect.local', name: 'QA', password: 'qapass123' });
    await createUser({ email: 'qa2@recollect.local', name: 'QA Visitor', password: 'qapass123' });
    await createUser({ email: 'old.friend@gmail.com', name: 'Old Friend', googleId: 'g-1', authProvider: 'google' });
    await prisma.subject.create({ data: { userId: qa.id, name: 'QA subject' } });
    await prisma.apiToken.create({ data: { userId: owner.id, name: 'Claude Code hooks', tokenHash: 'hash-hooks', prefix: 'rcl_aaaaaaaa', scopes: ['read'] } });
    await prisma.apiToken.create({ data: { userId: qa.id, name: 'QA token', tokenHash: 'hash-qa', prefix: 'rcl_bbbbbbbb', scopes: ['read'] } });
    const client = await prisma.oAuthClient.create({ data: { id: 'https://claude.ai/oauth/client', name: 'Claude', redirectUris: ['https://claude.ai/cb'], kind: 'cimd' } });
    const access = await prisma.apiToken.create({
        data: { userId: owner.id, name: 'Claude', tokenHash: 'hash-access', prefix: 'rcl_cccccccc', scopes: ['read'], oauthClientId: client.id, expiresAt: new Date(Date.now() + HOUR) },
    });
    await prisma.oAuthRefreshToken.create({ data: { tokenHash: 'hash-refresh', apiTokenId: access.id, expiresAt: new Date(Date.now() + 30 * 24 * HOUR) } });
    await prisma.oAuthCode.create({
        data: { codeHash: 'hash-code', clientId: client.id, userId: owner.id, redirectUri: 'https://claude.ai/cb', codeChallenge: 'x'.repeat(43), scopes: ['read'], resource: 'http://localhost:8002/mcp', expiresAt: new Date(Date.now() + HOUR) },
    });
    await prisma.pushSubscription.create({ data: { userId: owner.id, endpoint: 'https://push.example/owner', p256dh: 'p', auth: 'a' } });
    await prisma.pushSubscription.create({ data: { userId: qa.id, endpoint: 'https://push.example/qa', p256dh: 'p', auth: 'a' } });
    await prisma.otp.create({ data: { email: 'dev@recollect.local', otp: '123456', purpose: 'password_reset' } });
    await prisma.otp.create({ data: { email: 'qa@recollect.local', otp: '654321', purpose: 'password_reset' } });
    return { owner, qa };
}

/** Everything the cutover touches, as counts. */
async function snapshot() {
    return {
        users: await prisma.user.count(),
        liveTokens: await prisma.apiToken.count({ where: { revokedAt: null } }),
        tokens: await prisma.apiToken.count(),
        refresh: await prisma.oAuthRefreshToken.count(),
        codes: await prisma.oAuthCode.count(),
        clients: await prisma.oAuthClient.count(),
        push: await prisma.pushSubscription.count(),
        otp: await prisma.otp.count(),
        subjects: await prisma.subject.count(),
    };
}

beforeEach(async () => {
    await truncateAllTables(getTestDatabaseUrl());
});

describe('the cutover clean-up', () => {
    it('the dry run changes nothing and says what would happen', async () => {
        await seed();
        const before = await snapshot();
        const plan = await planCutover(prisma, { ownerEmail: 'Owner.Real@Example.org' });
        expect(plan.owner).toMatchObject({ from: 'dev@recollect.local', to: REAL, rename: true, morningEmail: 'follows' });
        expect(plan.deleteAccounts.map((a) => a.email).sort()).toEqual(['qa2@recollect.local', 'qa@recollect.local']);
        expect(plan.staying).toEqual([{ email: 'o***d@gmail.com', placeholder: false, signIn: 'google', docs: 0 }]);
        // what applying itself changes: the QA account's token and push subscription go with the account
        expect(plan.counts).toEqual({ liveTokens: 2, refreshTokens: 1, oauthCodes: 1, pushSubscriptions: 1, emailCodes: 2, oauthClients: 1 });
        expect(await snapshot()).toEqual(before);
    });

    it('applied: the QA accounts go with what they own, the owner takes the real address and password, nothing stays signed in', async () => {
        const { owner } = await seed();
        const { plan, result } = await applyCutover(prisma, { ownerEmail: REAL }, await hashPassword(NEW_PASSWORD));
        expect(result).toEqual({ deletedAccounts: 2, ownerRenamed: true, revokedTokens: 2, deletedRefreshTokens: 1, deletedOauthCodes: 1, deletedPushSubscriptions: 1, deletedEmailCodes: 2 });
        // the dry run's numbers are exactly what applying did
        expect([result.revokedTokens, result.deletedRefreshTokens, result.deletedOauthCodes, result.deletedPushSubscriptions, result.deletedEmailCodes]).toEqual([
            plan.counts.liveTokens,
            plan.counts.refreshTokens,
            plan.counts.oauthCodes,
            plan.counts.pushSubscriptions,
            plan.counts.emailCodes,
        ]);

        const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id }, omit: { password: false } });
        expect(after.email).toBe(REAL);
        expect(after.reminderEmail).toBe(REAL);
        expect(await verifyPassword(NEW_PASSWORD, after.password)).toBe(true);
        expect(await verifyPassword('devpass123', after.password)).toBe(false);
        expect(await snapshot()).toEqual({ users: 2, liveTokens: 0, tokens: 2, refresh: 0, codes: 0, clients: 1, push: 0, otp: 0, subjects: 0 });
        expect(await verifyCutover(prisma, { ownerEmail: REAL }, NEW_PASSWORD)).toEqual([]);
    });

    it('a second run finds nothing left to do', async () => {
        await seed();
        const hash = await hashPassword(NEW_PASSWORD);
        await applyCutover(prisma, { ownerEmail: REAL }, hash);
        const again = await planCutover(prisma, { ownerEmail: REAL });
        expect(again.owner).toMatchObject({ from: REAL, to: REAL, rename: false });
        expect(again.deleteAccounts).toEqual([]);
        expect(again.notFound.sort()).toEqual(['qa2@recollect.local', 'qa@recollect.local']);
        expect(again.counts).toEqual({ liveTokens: 0, refreshTokens: 0, oauthCodes: 0, pushSubscriptions: 0, emailCodes: 0, oauthClients: 1 });
        const { result } = await applyCutover(prisma, { ownerEmail: REAL }, hash);
        expect(result).toEqual({ deletedAccounts: 0, ownerRenamed: false, revokedTokens: 0, deletedRefreshTokens: 0, deletedOauthCodes: 0, deletedPushSubscriptions: 0, deletedEmailCodes: 0 });
        expect(await verifyCutover(prisma, { ownerEmail: REAL }, NEW_PASSWORD)).toEqual([]);
    });

    it('the real address already belongs to another account: refused untouched, unless that account is named for deletion', async () => {
        const { owner } = await seed();
        const holder = await createUser({ email: REAL, name: 'Old Google', googleId: 'g-2', authProvider: 'google' });
        const before = await snapshot();
        await expect(planCutover(prisma, { ownerEmail: REAL })).rejects.toThrow(/already used by another account .*--delete-account owner\.real@example\.org/);
        await expect(applyCutover(prisma, { ownerEmail: REAL }, await hashPassword(NEW_PASSWORD))).rejects.toThrow(/already used/);
        expect(await snapshot()).toEqual(before);

        const { plan } = await applyCutover(prisma, { ownerEmail: REAL, deleteEmails: [REAL.toUpperCase()] }, await hashPassword(NEW_PASSWORD));
        expect(plan.deleteAccounts.map((a) => a.why).sort()).toEqual(['named', 'qa', 'qa']);
        expect(await prisma.user.findUnique({ where: { id: holder.id } })).toBeNull();
        expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).email).toBe(REAL);
    });

    it('refuses, changing nothing: a QA workspace with another member, no owner account, a QA address as the owner', async () => {
        const { owner, qa } = await seed();
        const ws = await prisma.workspace.create({ data: { name: 'QA team', ownerId: qa.id } });
        await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: owner.id } });
        const before = await snapshot();
        const hash = await hashPassword(NEW_PASSWORD);
        await expect(applyCutover(prisma, { ownerEmail: REAL }, hash)).rejects.toThrow(/workspace\(s\) owned by an account to delete have other members/);
        await expect(applyCutover(prisma, { ownerEmail: REAL, fromEmail: 'nobody@recollect.local' }, hash)).rejects.toThrow(/No owner account/);
        await expect(planCutover(prisma, { ownerEmail: 'qa@recollect.local' })).rejects.toThrow(/cannot be a QA address/);
        expect(await snapshot()).toEqual(before);
    });
});
