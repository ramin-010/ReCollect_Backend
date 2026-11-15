import { describe, expect, it } from 'vitest';
import { accessibleDocWhere, canEditDoc, canViewDoc, getDocRole, isDocOwner, type DocAccessSubject } from '../../../src/services/docs/docPermissions';

const doc: DocAccessSubject = {
    userId: 'owner',
    collaborators: [
        { userId: 'editor', role: 'editor' },
        { userId: 'viewer', role: 'viewer' },
    ],
};

describe('doc permission helpers', () => {
    it.each([
        ['owner', 'owner', true, true],
        ['editor', 'editor', true, true],
        ['viewer', 'viewer', true, false],
        ['stranger', null, false, false],
    ] as const)('%s → role %s, view %s, edit %s', (userId, role, view, edit) => {
        expect(getDocRole(doc, userId)).toBe(role);
        expect(canViewDoc(doc, userId)).toBe(view);
        expect(canEditDoc(doc, userId)).toBe(edit);
    });

    it('isDocOwner only for the owner; the owner needs no collaborator row', () => {
        expect(isDocOwner(doc, 'owner')).toBe(true);
        expect(isDocOwner(doc, 'editor')).toBe(false);
        expect(getDocRole({ userId: 'owner', collaborators: [] }, 'owner')).toBe('owner');
    });

    it('works with collaborators pre-filtered to one user', () => {
        expect(getDocRole({ userId: 'owner', collaborators: [{ userId: 'viewer', role: 'viewer' }] }, 'viewer')).toBe('viewer');
    });

    it('accessibleDocWhere: owner or collaborator (no bans since the sharing rebuild)', () => {
        expect(accessibleDocWhere('u1')).toEqual({ OR: [{ userId: 'u1' }, { collaborators: { some: { userId: 'u1' } } }] });
    });
});
