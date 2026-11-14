// Workspace endpoints (Postgres). Same routes, status codes, messages and JSON shapes as the Mongo
// version; all DB access is in src/services/workspaces/workspaces.service.ts and every permission
// check comes from src/services/workspaces/workspacePermissions.ts.
import type { RequestHandler } from 'express';
import { requireUser } from '../../middlwares/auth';
import ErrorResponse from '../../utils/errorResponse';
import { serializeActivity, serializeWorkspace } from '../../db/serializers/workspace';
import { serializeTodos } from '../../services/todos/todoShape';
import { isAssignableWorkspaceRole } from '../../services/workspaces/workspacePermissions';
import * as workspaces from '../../services/workspaces/workspaces.service';
import { routeParam, spaceIdFilter } from './requestParams';

/**
 * POST /api/workspaces
 * Body: { name: string, defaultSpaceName?: string }
 */
export const createWorkspace: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const { name, defaultSpaceName } = req.body ?? {};

        if (!name || typeof name !== 'string' || !name.trim()) {
            throw new ErrorResponse(400, 'Workspace name is required');
        }

        const workspace = await workspaces.createWorkspace(user.id, { name, defaultSpaceName });
        res.status(201).json({ success: true, data: serializeWorkspace(workspace) });
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/workspaces
 * Returns all workspaces the user is a member of or owns
 */
export const getWorkspaces: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const rows = await workspaces.listWorkspacesForUser(user.id);
        res.status(200).json({ success: true, data: rows.map(serializeWorkspace) });
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/workspaces/:id
 */
export const getWorkspace: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const workspace = await workspaces.getWorkspaceForMember(routeParam(req, 'id'), user.id);
        res.status(200).json({ success: true, data: serializeWorkspace(workspace) });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/workspaces/:id/members
 * Body: { email: string }
 * Sends an invite notification to the user instead of directly adding them
 */
export const inviteMember: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const { email } = req.body ?? {};

        if (!email || typeof email !== 'string') {
            throw new ErrorResponse(400, 'Email is required');
        }

        const { message } = await workspaces.inviteMemberByEmail(
            routeParam(req, 'id'),
            { id: user.id, name: user.name, email: user.email },
            email
        );
        res.status(200).json({ success: true, message });
    } catch (err) {
        next(err);
    }
};

/**
 * DELETE /api/workspaces/:id/members/:userId
 * Remove a member from the workspace (admins), or leave it (yourself)
 */
export const removeMember: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const updated = await workspaces.removeWorkspaceMember(routeParam(req, 'id'), user.id, routeParam(req, 'userId'));
        res.status(200).json({ success: true, data: serializeWorkspace(updated), message: 'Member removed' });
    } catch (err) {
        next(err);
    }
};

/**
 * PATCH /api/workspaces/:id/members/:userId/role
 * Update a member's role (Owner or Admin only, but Admin cannot modify Owner)
 */
export const updateWorkspaceRole: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const { role } = req.body ?? {};

        if (!isAssignableWorkspaceRole(role)) {
            throw new ErrorResponse(400, 'Invalid role');
        }

        const updated = await workspaces.updateWorkspaceMemberRole(
            routeParam(req, 'id'),
            user.id,
            routeParam(req, 'userId'),
            role
        );
        res.status(200).json({ success: true, data: serializeWorkspace(updated), message: 'Role updated' });
    } catch (err) {
        next(err);
    }
};

/**
 * DELETE /api/workspaces/:id
 * Delete workspace (owner only)
 */
export const deleteWorkspace: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        await workspaces.deleteWorkspace(routeParam(req, 'id'), user.id);
        res.status(200).json({ success: true, message: 'Workspace deleted' });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/workspaces/:id/spaces
 * Add a new space to the workspace
 */
export const createSpace: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const { name } = req.body ?? {};

        if (!name || typeof name !== 'string' || !name.trim()) {
            throw new ErrorResponse(400, 'Space name is required');
        }

        const updated = await workspaces.createSpace(routeParam(req, 'id'), user.id, name);
        res.status(201).json({ success: true, data: serializeWorkspace(updated), message: 'Space created' });
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/workspaces/:id/tasks?spaceId=<id|all>
 * Returns all tasks belonging to this workspace
 */
export const getWorkspaceTasks: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const tasks = await workspaces.listWorkspaceTasks(routeParam(req, 'id'), user.id, spaceIdFilter(req.query.spaceId));
        res.status(200).json({ success: true, data: serializeTodos(tasks), count: tasks.length });
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/workspaces/:id/stats?spaceId=<id|all>
 * Returns aggregate stats for the workspace dashboard
 */
export const getWorkspaceStats: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const stats = await workspaces.getWorkspaceStats(routeParam(req, 'id'), user.id, spaceIdFilter(req.query.spaceId));
        res.status(200).json({ success: true, data: stats });
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/workspaces/:id/activity
 * Returns the last 30 activity log entries for a workspace
 */
export const getWorkspaceActivity: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const activity = await workspaces.getWorkspaceActivity(routeParam(req, 'id'), user.id);
        res.status(200).json({ success: true, data: activity.map(serializeActivity) });
    } catch (err) {
        next(err);
    }
};

/**
 * PATCH /api/workspaces/:id/settings
 * Update workspace settings (only owner or admins)
 */
export const updateWorkspaceSettings: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const { membersCanViewOverview } = req.body ?? {};
        const updated = await workspaces.updateWorkspaceSettings(routeParam(req, 'id'), user.id, { membersCanViewOverview });
        res.status(200).json({ success: true, data: serializeWorkspace(updated), message: 'Settings updated' });
    } catch (err) {
        next(err);
    }
};
