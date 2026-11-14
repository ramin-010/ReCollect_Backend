import { describe, expect, it } from 'vitest';
import {
    accessibleDrawingWhere,
    canEditDrawing,
    canViewDrawing,
    getDrawingRole,
    isDrawingOwner,
    isValidDrawingShareToken,
    type DrawingAccessSubject,
} from '../../../src/services/drawings/drawingPermissions';

const drawing: DrawingAccessSubject = {
    userId: 'owner',
    collaborators: [
        { userId: 'editor', role: 'editor' },
        { userId: 'viewer', role: 'viewer' },
    ],
};

describe('drawing permission helpers', () => {
    it.each([
        ['owner', 'owner', true, true],
        ['editor', 'editor', true, true],
        ['viewer', 'viewer', true, false],
        ['stranger', null, false, false],
    ] as const)('%s → role %s, view %s, edit %s', (userId, role, view, edit) => {
        expect(getDrawingRole(drawing, userId)).toBe(role);
        expect(canViewDrawing(drawing, userId)).toBe(view);
        expect(canEditDrawing(drawing, userId)).toBe(edit);
    });

    it('isDrawingOwner', () => {
        expect(isDrawingOwner(drawing, 'owner')).toBe(true);
        expect(isDrawingOwner(drawing, 'editor')).toBe(false);
    });

    it('a share token is valid only while sharing is enabled and it matches exactly', () => {
        expect(isValidDrawingShareToken({ shareToken: 'abc', shareEnabled: true }, 'abc')).toBe(true);
        expect(isValidDrawingShareToken({ shareToken: 'abc', shareEnabled: false }, 'abc')).toBe(false);
        expect(isValidDrawingShareToken({ shareToken: 'abc', shareEnabled: true }, 'abd')).toBe(false);
        expect(isValidDrawingShareToken({ shareToken: null, shareEnabled: true }, null)).toBe(false);
        expect(isValidDrawingShareToken({ shareToken: null, shareEnabled: true }, undefined)).toBe(false);
        expect(isValidDrawingShareToken({ shareToken: '', shareEnabled: true }, '')).toBe(false);
    });

    it('accessibleDrawingWhere: owner or collaborator', () => {
        expect(accessibleDrawingWhere('u1')).toEqual({ OR: [{ userId: 'u1' }, { collaborators: { some: { userId: 'u1' } } }] });
    });
});
