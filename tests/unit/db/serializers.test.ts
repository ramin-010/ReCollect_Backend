import { describe, expect, it } from 'vitest';
import { serializeUser, serializeUserSummary, serializeUserSummaryOrNull, withMongoId, withMongoIds } from '../../../src/db/serializers';

const userRow = {
    id: 'cuser123',
    name: 'Ada',
    email: 'ada@example.test',
    reminderEmail: 'ada@example.test',
    phone: '',
    password: '$2b$10$hash',
    avatar: '',
    cloudPublicId: '',
    cloudProvider: '',
    status: 'active' as const,
    isGhost: false,
    googleId: '',
    authProvider: 'local' as const,
    timezone: 'Asia/Kolkata',
    routineMode: 'MASTER' as const,
    globalStreak: 0,
    longestGlobalStreak: 0,
    lastGlobalStreakDay: null,
    globalStreakBeforeCredit: null,
    learningRolledOverDay: null,
    dailyBudgetMin: 25,
    leetcodeUser: null,
    leetcodeSyncedAt: null,
    progressIncludesWork: false,
    progressIncludesBuilding: true,
    newFolders: 'ask' as const,
    routineEnabled: false,
    busyUntil: null,
    nudgeEmailEnabled: true,
    nudgeTime: '08:30',
    lastNudgeDay: null,
    lastPushDay: null,
    lastSeenDay: null,
    agentProfile: null,
    prevSeenDay: null,
    plan: 'free',
    accessEndedAt: null,
    firstRun: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
};

describe('withMongoId', () => {
    it('renames id to _id at the top level only', () => {
        const row = { id: 'c1', title: 'Doc', content: { id: 'tiptap-node-id', items: [{ id: 'x' }] } };
        const out = withMongoId(row);
        expect(out).toEqual({ _id: 'c1', title: 'Doc', content: { id: 'tiptap-node-id', items: [{ id: 'x' }] } });
        expect('id' in out).toBe(false);
    });

    it('maps lists', () => {
        expect(withMongoIds([{ id: 'a' }, { id: 'b' }])).toEqual([{ _id: 'a' }, { _id: 'b' }]);
    });
});

describe('user serializers', () => {
    it('serializeUser never includes the password and exposes _id', () => {
        const json = serializeUser(userRow);
        expect(json._id).toBe('cuser123');
        expect(json).not.toHaveProperty('password');
        expect(json).not.toHaveProperty('id');
        expect(JSON.parse(JSON.stringify(json)).createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('serializeUserSummary is the populate("name email avatar") shape', () => {
        expect(serializeUserSummary(userRow)).toEqual({ _id: 'cuser123', name: 'Ada', email: 'ada@example.test', avatar: '' });
        expect(serializeUserSummaryOrNull(null)).toBeNull();
    });
});
