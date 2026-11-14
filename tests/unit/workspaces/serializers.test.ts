// Workspace + activity JSON shapes (no database).
import { describe, expect, it } from 'vitest';
import {
    normalizeWorkspaceSettings,
    serializeActivity,
    serializeWorkspace,
    type ActivityWithRelations,
    type WorkspaceWithRelations,
} from '../../../src/db/serializers/workspace';

const ada = { id: 'u1', name: 'Ada', email: 'ada@example.test', avatar: '' };
const bob = { id: 'u2', name: 'Bob', email: 'bob@example.test', avatar: 'https://cdn/b.png' };
const t0 = new Date('2026-01-01T00:00:00Z');

const row: WorkspaceWithRelations = {
    id: 'w1',
    name: 'Acme',
    ownerId: 'u1',
    settings: { membersCanViewOverview: true },
    createdAt: t0,
    updatedAt: t0,
    owner: ada,
    members: [
        { workspaceId: 'w1', userId: 'u1', role: 'admin', joinedAt: t0, user: ada },
        { workspaceId: 'w1', userId: 'u2', role: 'viewer', joinedAt: t0, user: bob },
    ],
    spaces: [{ id: 's1', workspaceId: 'w1', name: 'Team 1', createdAt: t0 }],
};

describe('serializeWorkspace', () => {
    it('is the old populated shape (no ownerId, member rows without ids, spaces with _id)', () => {
        expect(serializeWorkspace(row)).toEqual({
            _id: 'w1',
            name: 'Acme',
            owner: { _id: 'u1', name: 'Ada', email: 'ada@example.test', avatar: '' },
            members: [
                { user: { _id: 'u1', name: 'Ada', email: 'ada@example.test', avatar: '' }, role: 'admin', joinedAt: t0 },
                { user: { _id: 'u2', name: 'Bob', email: 'bob@example.test', avatar: 'https://cdn/b.png' }, role: 'viewer', joinedAt: t0 },
            ],
            spaces: [{ _id: 's1', name: 'Team 1' }],
            settings: { membersCanViewOverview: true },
            createdAt: t0,
            updatedAt: t0,
        });
    });

    it('fills in the settings default', () => {
        expect(normalizeWorkspaceSettings({})).toEqual({ membersCanViewOverview: false });
        expect(normalizeWorkspaceSettings(null)).toEqual({ membersCanViewOverview: false });
        expect(normalizeWorkspaceSettings([])).toEqual({ membersCanViewOverview: false });
        expect(normalizeWorkspaceSettings({ membersCanViewOverview: 'yes' })).toEqual({ membersCanViewOverview: false });
    });
});

describe('serializeActivity', () => {
    it('puts the old keys back; targetUser/targetTask may be null', () => {
        const activity: ActivityWithRelations = {
            id: 'a1',
            workspaceId: 'w1',
            actorId: 'u1',
            action: 'task_assigned',
            targetTaskId: 't1',
            targetUserId: null,
            metadata: 'Write docs',
            createdAt: t0,
            updatedAt: t0,
            actor: ada,
            targetUser: null,
        };
        expect(serializeActivity(activity)).toEqual({
            _id: 'a1',
            workspace: 'w1',
            actor: { _id: 'u1', name: 'Ada', email: 'ada@example.test', avatar: '' },
            action: 'task_assigned',
            targetTask: 't1',
            targetUser: null,
            metadata: 'Write docs',
            createdAt: t0,
            updatedAt: t0,
        });
    });
});
