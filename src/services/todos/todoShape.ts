// The todo JSON shape, shared by personal tasks (/api/todos) and workspace tasks (/api/workspace-todos).
//
// Usage:
//   const row = await db.todo.findUnique({ where: { id }, include: todoInclude });
//   res.json({ success: true, data: serializeTodo(row) });
//
// What the Mongo API returned, and what serializeTodo returns now (ONE shape for every endpoint):
//   _id         the todo id
//   user        populate('user', 'name email avatar') in the workspace list/create/update; a bare id in
//               the personal endpoints. Now ALWAYS the summary { _id, name, email, avatar } (a superset;
//               the frontend never reads todo.user).
//   tags        populate('tags', 'name') / ('name color'; Tags has no color) → [{ _id, name }]. The
//               create/update responses used to return bare ids; they now get the objects too.
//   assignees   populate('assignees', 'name email avatar') → [{ _id, name, email, avatar }] (create/update
//               used to return bare ids; the frontend accepts both, see AssignedView).
//   workspace   always the bare workspace id or null (the frontend tests `task.workspace` to pick the API).
//   spaceId     the bare space id or null.
//   subtasks, cloudImages, references, recurrence: the Json columns, passed through untouched.
//   No __v.
//
// Array order: Mongo kept tags/assignees in array (insertion) order. The join tables are ordered by
// createdAt, so write them with todoTagRows()/todoAssigneeRows() (1 ms apart) to keep that order.
import type { GoalType, Prisma, Todo, TodoPriority, TodoStatus, TodoVisibility } from '@prisma/client';
import { serializeUserSummary, userSummarySelect, type UserSummaryJson, type UserSummaryRow } from '../../db/serializers';

/** The tag fields the old populate returned. */
export const todoTagSelect = { id: true, name: true } as const;

/** Include this in every todo query whose result goes to serializeTodo(). */
export const todoInclude = {
    user: { select: userSummarySelect },
    tags: {
        select: { tag: { select: todoTagSelect } },
        orderBy: [{ createdAt: 'asc' }, { tagId: 'asc' }],
    },
    assignees: {
        select: { user: { select: userSummarySelect } },
        orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
    },
} satisfies Prisma.TodoInclude;

/** A todo row loaded with `include: todoInclude`. */
export type TodoWithRelations = Prisma.TodoGetPayload<{ include: typeof todoInclude }>;

/**
 * What serializeTodo() needs. Structural on purpose: any todo row that has the scalar columns plus
 * `user`, `tags[].tag` and `assignees[].user` works, even with extra relations included.
 */
export type TodoRowForJson = Todo & {
    user: UserSummaryRow;
    tags: ReadonlyArray<{ tag: { id: string; name: string } }>;
    assignees: ReadonlyArray<{ user: UserSummaryRow }>;
};

export interface TodoTagJson {
    _id: string;
    name: string;
}

export interface TodoJson {
    _id: string;
    user: UserSummaryJson;
    title: string;
    description: string | null;
    status: TodoStatus;
    priority: TodoPriority;
    dueDate: Date | null;
    reminderDate: Date | null;
    completedAt: Date | null;
    /** [{ id, text, isCompleted }] */
    subtasks: Prisma.JsonValue;
    /** [{ imageId, cloudPublicId }] */
    cloudImages: Prisma.JsonValue;
    tags: TodoTagJson[];
    /** { pattern, interval } or null */
    recurrence: Prisma.JsonValue | null;
    assignees: UserSummaryJson[];
    assignedAt: Date | null;
    visibility: TodoVisibility;
    /** Workspace id (Mongo `workspace`), or null for personal tasks. */
    workspace: string | null;
    spaceId: string | null;
    /** [{ type, refId, title? }] */
    references: Prisma.JsonValue;
    /** Revise weekly/monthly goal type (learning Home). */
    goalType: GoalType;
    createdAt: Date;
    updatedAt: Date;
}

/** Prisma todo row (loaded with todoInclude) → the old todo JSON. */
export function serializeTodo(row: TodoRowForJson): TodoJson {
    return {
        _id: row.id,
        user: serializeUserSummary(row.user),
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        dueDate: row.dueDate,
        reminderDate: row.reminderDate,
        completedAt: row.completedAt,
        subtasks: row.subtasks,
        cloudImages: row.cloudImages,
        tags: row.tags.map(({ tag }) => ({ _id: tag.id, name: tag.name })),
        recurrence: row.recurrence,
        assignees: row.assignees.map(({ user }) => serializeUserSummary(user)),
        assignedAt: row.assignedAt,
        visibility: row.visibility,
        workspace: row.workspaceId,
        spaceId: row.spaceId,
        references: row.references,
        goalType: row.goalType,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

/** serializeTodo for a list. */
export function serializeTodos(rows: readonly TodoRowForJson[]): TodoJson[] {
    return rows.map((row) => serializeTodo(row));
}

/**
 * TodoTag rows for `createMany`, in array order: createdAt is `now`, `now + 1 ms`, … so that
 * todoInclude's `orderBy createdAt` returns the tags in the order given (Mongo array order).
 * Duplicate ids are dropped (TodoTag is unique on (todoId, tagId)).
 */
export function todoTagRows(todoId: string, tagIds: readonly string[], now: Date = new Date()): Prisma.TodoTagCreateManyInput[] {
    return uniqueIds(tagIds).map((tagId, i) => ({ todoId, tagId, createdAt: new Date(now.getTime() + i) }));
}

/** TodoAssignee rows for `createMany`, in array order (see todoTagRows). Duplicate ids are dropped. */
export function todoAssigneeRows(
    todoId: string,
    userIds: readonly string[],
    now: Date = new Date()
): Prisma.TodoAssigneeCreateManyInput[] {
    return uniqueIds(userIds).map((userId, i) => ({ todoId, userId, createdAt: new Date(now.getTime() + i) }));
}

function uniqueIds(ids: readonly string[]): string[] {
    return [...new Set(ids)];
}
