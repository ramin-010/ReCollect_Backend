// The shared workspace permission helpers, for every role (no database).
import { describe, expect, it } from 'vitest';
import {
    canDeleteWorkspace,
    canEditTasks,
    canManageInviteLinks,
    canManageMembers,
    canManageSettings,
    canViewOverview,
    getWorkspaceRole,
    getWorkspaceRoleFromMembers,
    hasWorkspaceRole,
    isAdmin,
    isAssignableWorkspaceRole,
    isMember,
    isOwner,
    requireWorkspaceRole,
    workspaceTaskAccess,
    WORKSPACE_ADMIN_ROLES,
    type WorkspaceAccessRole,
} from '../../../src/services/workspaces/workspacePermissions';

const ROLES: Array<WorkspaceAccessRole | null> = ['owner', 'admin', 'member', 'viewer', null];
const label = (role: WorkspaceAccessRole | null) => role ?? 'non-member';

/** Expected answers per role, in ROLES order: owner, admin, member, viewer, non-member. */
const MATRIX: Array<[string, (role: WorkspaceAccessRole | null) => boolean, boolean[]]> = [
    ['isMember', isMember, [true, true, true, true, false]],
    ['isOwner', isOwner, [true, false, false, false, false]],
    ['isAdmin', isAdmin, [true, true, false, false, false]],
    ['canManageMembers', canManageMembers, [true, true, false, false, false]],
    ['canManageSettings', canManageSettings, [true, true, false, false, false]],
    ['canManageInviteLinks', canManageInviteLinks, [true, true, false, false, false]],
    ['canEditTasks', canEditTasks, [true, true, true, false, false]],
    ['canDeleteWorkspace', canDeleteWorkspace, [true, false, false, false, false]],
    ['canViewOverview (setting off)', (r) => canViewOverview(r, { membersCanViewOverview: false }), [true, true, false, false, false]],
    ['canViewOverview (setting on)', (r) => canViewOverview(r, { membersCanViewOverview: true }), [true, true, true, true, false]],
    ['canViewOverview (no settings)', (r) => canViewOverview(r, null), [true, true, false, false, false]],
];

describe('permission helpers per role', () => {
    for (const [name, check, expected] of MATRIX) {
        it(name, () => {
            const actual = ROLES.map((role) => `${label(role)}=${check(role)}`);
            const wanted = ROLES.map((role, i) => `${label(role)}=${expected[i]}`);
            expect(actual).toEqual(wanted);
        });
    }

    it('workspaceTaskAccess: editors allowed, viewers get the viewer branch, others denied', () => {
        expect(ROLES.map(workspaceTaskAccess)).toEqual(['allowed', 'allowed', 'allowed', 'viewer', 'denied']);
    });
});

describe('getWorkspaceRole', () => {
    it('the owner outranks their own member row', () => {
        expect(getWorkspaceRole('u1', 'admin', 'u1')).toBe('owner');
        expect(getWorkspaceRole('u1', 'viewer', 'u1')).toBe('owner');
        expect(getWorkspaceRole('u1', undefined, 'u1')).toBe('owner');
    });

    it('otherwise the member role, or null', () => {
        expect(getWorkspaceRole('owner', 'member', 'u2')).toBe('member');
        expect(getWorkspaceRole('owner', null, 'u2')).toBeNull();
    });

    it('from a member list', () => {
        const members = [
            { userId: 'a', role: 'admin' as const },
            { userId: 'v', role: 'viewer' as const },
        ];
        expect(getWorkspaceRoleFromMembers('o', members, 'v')).toBe('viewer');
        expect(getWorkspaceRoleFromMembers('o', members, 'o')).toBe('owner');
        expect(getWorkspaceRoleFromMembers('o', members, 'x')).toBeNull();
    });
});

describe('requireWorkspaceRole', () => {
    it('returns the role when allowed', () => {
        expect(requireWorkspaceRole({ role: 'admin' }, WORKSPACE_ADMIN_ROLES, 'nope')).toBe('admin');
    });

    it('throws a 403 ErrorResponse with the given message otherwise', () => {
        for (const role of ['member', 'viewer', null] as const) {
            expect(() => requireWorkspaceRole({ role }, WORKSPACE_ADMIN_ROLES, 'Only admins can invite members')).toThrow(
                expect.objectContaining({ statusCode: 403, message: 'Only admins can invite members' })
            );
        }
    });

    it('hasWorkspaceRole never matches null', () => {
        expect(hasWorkspaceRole(null, ['owner', 'admin', 'member', 'viewer'])).toBe(false);
    });
});

describe('isAssignableWorkspaceRole', () => {
    it('accepts admin/member/viewer only', () => {
        expect(['admin', 'member', 'viewer'].every(isAssignableWorkspaceRole)).toBe(true);
        for (const value of ['owner', 'Admin', '', null, undefined, 1, {}]) {
            expect(isAssignableWorkspaceRole(value)).toBe(false);
        }
    });
});
