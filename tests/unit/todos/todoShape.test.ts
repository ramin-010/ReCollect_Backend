import { describe, expect, it } from 'vitest';
import { serializeTodo, serializeTodos, todoAssigneeRows, todoInclude, todoTagRows, type TodoWithRelations } from '../../../src/services/todos/todoShape';

const owner = { id: 'cowner', name: 'Owner', email: 'owner@example.test', avatar: '' };
const helper = { id: 'chelper', name: 'Helper', email: 'helper@example.test', avatar: 'https://cdn.example.test/h.png' };

function row(overrides: Partial<TodoWithRelations> = {}): TodoWithRelations {
    return {
        id: 'ctodo1',
        userId: owner.id,
        title: 'Write the report',
        description: '<p>hi</p>',
        status: 'pending',
        priority: 'medium',
        dueDate: new Date('2026-10-22T12:30:00.000Z'),
        reminderDate: null,
        completedAt: null,
        subtasks: [{ id: 'st1', text: 'Outline', isCompleted: false }],
        cloudImages: [{ imageId: 'img1', cloudPublicId: 'recollect-todos/img1' }],
        recurrence: { pattern: 'weekly', interval: 2 },
        assignedAt: null,
        visibility: 'private',
        workspaceId: null,
        spaceId: null,
        references: [{ type: 'doc', refId: 'cdoc1', title: 'Spec' }],
        goalType: 'NONE',
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-02T00:00:00.000Z'),
        user: owner,
        tags: [{ tag: { id: 'ctag1', name: 'design' } }, { tag: { id: 'ctag2', name: 'bug' } }],
        assignees: [{ user: helper }],
        ...overrides,
    };
}

describe('serializeTodo', () => {
    it('produces the old todo JSON: _id, populated tags/assignees/user, workspace/spaceId keys, Json untouched', () => {
        const json = serializeTodo(row());
        expect(json).toEqual({
            _id: 'ctodo1',
            user: { _id: 'cowner', name: 'Owner', email: 'owner@example.test', avatar: '' },
            title: 'Write the report',
            description: '<p>hi</p>',
            status: 'pending',
            priority: 'medium',
            dueDate: new Date('2026-10-22T12:30:00.000Z'),
            reminderDate: null,
            completedAt: null,
            subtasks: [{ id: 'st1', text: 'Outline', isCompleted: false }],
            cloudImages: [{ imageId: 'img1', cloudPublicId: 'recollect-todos/img1' }],
            tags: [
                { _id: 'ctag1', name: 'design' },
                { _id: 'ctag2', name: 'bug' },
            ],
            recurrence: { pattern: 'weekly', interval: 2 },
            assignees: [{ _id: 'chelper', name: 'Helper', email: 'helper@example.test', avatar: 'https://cdn.example.test/h.png' }],
            assignedAt: null,
            visibility: 'private',
            workspace: null,
            spaceId: null,
            references: [{ type: 'doc', refId: 'cdoc1', title: 'Spec' }],
            goalType: 'NONE',
            createdAt: new Date('2026-10-01T00:00:00.000Z'),
            updatedAt: new Date('2026-10-02T00:00:00.000Z'),
        });
        // Renamed FK keys are not leaked.
        for (const key of ['id', 'userId', 'workspaceId', '__v']) expect(key in json).toBe(false);
    });

    it('never renames ids inside Json columns (subtasks keep `id`)', () => {
        const json = serializeTodo(row());
        expect((json.subtasks as any[])[0]).toHaveProperty('id', 'st1');
        expect((json.subtasks as any[])[0]).not.toHaveProperty('_id');
    });

    it('restores `workspace` and `spaceId` for a workspace task', () => {
        const json = serializeTodo(row({ workspaceId: 'cws1', spaceId: 'cspace1', visibility: 'workspace' }));
        expect(json).toMatchObject({ workspace: 'cws1', spaceId: 'cspace1', visibility: 'workspace' });
    });

    it('works with extra relations included and with empty tags/assignees', () => {
        const extended = { ...row({ tags: [], assignees: [] }), space: { id: 'cspace1', name: 'Space' } };
        const [json] = serializeTodos([extended]);
        expect(json).toMatchObject({ tags: [], assignees: [] });
        expect(json).not.toHaveProperty('space');
    });

    it('todoInclude loads user, tags and assignees in array (createdAt) order', () => {
        expect(Object.keys(todoInclude).sort()).toEqual(['assignees', 'tags', 'user']);
        expect(todoInclude.tags.orderBy[0]).toEqual({ createdAt: 'asc' });
        expect(todoInclude.assignees.orderBy[0]).toEqual({ createdAt: 'asc' });
    });
});

describe('todoTagRows / todoAssigneeRows', () => {
    it('spaces createdAt 1 ms apart in the given order and drops duplicates', () => {
        const now = new Date('2026-10-21T10:00:00.000Z');
        expect(todoTagRows('t1', ['b', 'a', 'b'], now)).toEqual([
            { todoId: 't1', tagId: 'b', createdAt: new Date('2026-10-21T10:00:00.000Z') },
            { todoId: 't1', tagId: 'a', createdAt: new Date('2026-10-21T10:00:00.001Z') },
        ]);
        expect(todoAssigneeRows('t1', ['u2', 'u1'], now).map((r) => r.userId)).toEqual(['u2', 'u1']);
    });
});
