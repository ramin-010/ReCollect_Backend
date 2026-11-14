// Workspace fixtures for integration tests: rows are written with Prisma directly (fast), so a test
// only goes through the API for the behaviour it checks.
import type { Prisma, WorkspaceRole } from '@prisma/client';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from './auth';
import type { SafeUser } from '../../src/services/users/users.service';

export interface TestWorkspace {
    id: string;
    name: string;
    ownerId: string;
    spaceIds: string[];
}

let counter = 0;

/**
 * A workspace like POST /api/workspaces makes: the owner is also an 'admin' member, plus the given
 * members and spaces (default: one space "Team 1").
 */
export async function createTestWorkspace(
    owner: { id: string },
    options: {
        name?: string;
        members?: Array<{ user: { id: string }; role: WorkspaceRole }>;
        spaces?: string[];
        settings?: Prisma.InputJsonObject;
    } = {}
): Promise<TestWorkspace> {
    counter += 1;
    const now = Date.now();
    const spaces = options.spaces ?? ['Team 1'];
    const workspace = await prisma.workspace.create({
        data: {
            name: options.name ?? `Workspace ${counter}`,
            ownerId: owner.id,
            ...(options.settings ? { settings: options.settings } : {}),
            members: {
                create: [
                    { userId: owner.id, role: 'admin', joinedAt: new Date(now) },
                    ...(options.members ?? []).map((m, i) => ({ userId: m.user.id, role: m.role, joinedAt: new Date(now + i + 1) })),
                ],
            },
            spaces: { create: spaces.map((name, i) => ({ name, createdAt: new Date(now + i) })) },
        },
        include: { spaces: { orderBy: { createdAt: 'asc' } } },
    });
    return { id: workspace.id, name: workspace.name, ownerId: workspace.ownerId, spaceIds: workspace.spaces.map((s) => s.id) };
}

/** A workspace with one user per role: owner (admin row), admin, member, viewer, plus an outsider. */
export async function createRoleFixture(options: { settings?: Prisma.InputJsonObject } = {}): Promise<{
    workspace: TestWorkspace;
    owner: SafeUser;
    admin: SafeUser;
    member: SafeUser;
    viewer: SafeUser;
    outsider: SafeUser;
}> {
    const [owner, admin, member, viewer, outsider] = await Promise.all([
        createTestUser({ name: 'Owner' }),
        createTestUser({ name: 'Admin' }),
        createTestUser({ name: 'Member' }),
        createTestUser({ name: 'Viewer' }),
        createTestUser({ name: 'Outsider' }),
    ]);
    const workspace = await createTestWorkspace(owner, {
        members: [
            { user: admin, role: 'admin' },
            { user: member, role: 'member' },
            { user: viewer, role: 'viewer' },
        ],
        ...(options.settings ? { settings: options.settings } : {}),
    });
    return { workspace, owner, admin, member, viewer, outsider };
}

/** A workspace todo row (visibility 'workspace'), created directly. */
export async function createWorkspaceTodoRow(
    workspace: { id: string },
    creator: { id: string },
    data: Partial<Prisma.TodoUncheckedCreateInput> = {}
) {
    return prisma.todo.create({
        data: {
            userId: creator.id,
            title: 'Workspace task',
            visibility: 'workspace',
            workspaceId: workspace.id,
            ...data,
        },
    });
}
