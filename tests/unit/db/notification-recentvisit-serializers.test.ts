import { describe, expect, it } from 'vitest';
import { serializeNotification } from '../../../src/db/serializers/notification';
import { serializeRecentVisit } from '../../../src/db/serializers/recentVisit';

const base = {
    id: 'cnotif1',
    recipientId: 'crecipient',
    senderId: 'csender',
    category: 'actionable' as const,
    type: 'workspace_invite',
    title: 'Workspace Invitation',
    message: 'Join us',
    icon: null,
    metadata: { workspaceId: 'cws1', role: 'member', nested: { id: 'keep-me' } },
    status: 'pending' as const,
    isRead: false,
    scheduledFor: null,
    expiresAt: null,
    createdAt: new Date('2026-10-20T00:00:00.000Z'),
    updatedAt: new Date('2026-10-20T00:00:00.000Z'),
};

describe('serializeNotification', () => {
    it('without the sender loaded: `sender` is the bare id (the old unpopulated endpoints)', () => {
        const json = serializeNotification(base);
        expect(json).toEqual({
            _id: 'cnotif1',
            recipient: 'crecipient',
            sender: 'csender',
            category: 'actionable',
            type: 'workspace_invite',
            title: 'Workspace Invitation',
            message: 'Join us',
            icon: null,
            metadata: { workspaceId: 'cws1', role: 'member', nested: { id: 'keep-me' } },
            status: 'pending',
            isRead: false,
            scheduledFor: null,
            expiresAt: null,
            createdAt: base.createdAt,
            updatedAt: base.updatedAt,
        });
    });

    it('with the sender loaded: the user summary, or null when the sender is gone', () => {
        const sender = { id: 'csender', name: 'Sam', email: 'sam@example.test', avatar: '' };
        expect(serializeNotification({ ...base, sender }).sender).toEqual({ _id: 'csender', name: 'Sam', email: 'sam@example.test', avatar: '' });
        expect(serializeNotification({ ...base, senderId: null, sender: null }).sender).toBeNull();
    });

    it('accepts any metadata payload (other modules write their own)', () => {
        expect(serializeNotification({ ...base, metadata: [] }).metadata).toEqual([]);
        expect(serializeNotification({ ...base, metadata: 'text' }).metadata).toBe('text');
    });
});

describe('serializeRecentVisit', () => {
    it('{ _id, user, itemId, itemType, title, route, visitedAt }', () => {
        const visitedAt = new Date('2026-10-21T00:00:00.000Z');
        expect(
            serializeRecentVisit({ id: 'cv1', userId: 'cu1', itemId: 'cdoc1', itemType: 'doc', title: 'Doc', route: '/docs/cdoc1', visitedAt })
        ).toEqual({ _id: 'cv1', user: 'cu1', itemId: 'cdoc1', itemType: 'doc', title: 'Doc', route: '/docs/cdoc1', visitedAt });
    });
});
