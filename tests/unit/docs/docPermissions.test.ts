import { describe, expect, it } from 'vitest';
import {
    accessibleDocWhere,
    canEditDoc,
    canViewDoc,
    getDocRole,
    isBannedFromDoc,
    isDocOwner,
    type DocAccessSubject,
} from '../../../src/services/docs/docPermissions';

const doc: DocAccessSubject = {
    userId: 'owner',
    collaborators: [
        { userId: 'editor', role: 'editor' },
        { userId: 'viewer', role: 'viewer' },
        // Not reachable through the API (removal deletes the row and bans in one transaction), but if
        // it ever exists the ban must win.
        { userId: 'banned-collaborator', role: 'editor' },
    ],
    bannedUsers: [{ userId: 'banned' }, { userId: 'banned-collaborator' }, { userId: 'owner' }],
};

describe('doc permission helpers', () => {
    it.each([
        ['owner', 'owner', true, true],
        ['editor', 'editor', true, true],
        ['viewer', 'viewer', true, false],
        ['banned', null, false, false],
        ['banned-collaborator', null, false, false],
        ['stranger', null, false, false],
    ] as const)('%s → role %s, view %s, edit %s', (userId, role, view, edit) => {
        expect(getDocRole(doc, userId)).toBe(role);
        expect(canViewDoc(doc, userId)).toBe(view);
        expect(canEditDoc(doc, userId)).toBe(edit);
    });

    it('isDocOwner only for the owner; a ban row never locks the owner out', () => {
        expect(isDocOwner(doc, 'owner')).toBe(true);
        expect(isDocOwner(doc, 'editor')).toBe(false);
        expect(isBannedFromDoc(doc, 'owner')).toBe(true);
        expect(canEditDoc(doc, 'owner')).toBe(true);
    });

    it('works with bannedUsers pre-filtered or left out', () => {
        const noBans = { userId: 'owner', collaborators: [{ userId: 'viewer', role: 'viewer' as const }] };
        expect(getDocRole(noBans, 'viewer')).toBe('viewer');
        expect(isBannedFromDoc(noBans, 'viewer')).toBe(false);
    });

    it('accessibleDocWhere: owner, or collaborator without a ban', () => {
        expect(accessibleDocWhere('u1')).toEqual({
            OR: [{ userId: 'u1' }, { collaborators: { some: { userId: 'u1' } }, bannedUsers: { none: { userId: 'u1' } } }],
        });
    });
});
