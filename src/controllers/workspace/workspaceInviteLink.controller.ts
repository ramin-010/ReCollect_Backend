// Workspace invite links + join requests (Postgres). Same routes, status codes, messages and JSON
// shapes as the Mongo version; DB access is in src/services/workspaces/workspaceInviteLinks.service.ts.
// Approving / rejecting a join request happens through the notification accept/decline endpoints:
// see approveWorkspaceJoinRequest / rejectWorkspaceJoinRequest in that service.
import type { RequestHandler } from 'express';
import { requireUser } from '../../middlwares/auth';
import * as inviteLinks from '../../services/workspaces/workspaceInviteLinks.service';
import { routeParam } from './requestParams';

// ─────────────────────────────────────────────────────────────
// POST /api/workspaces/:id/invite-link
// Generate (or return existing) invite link for a workspace/space
// Body: { spaceId?: string, expiresInDays?: number }
// ─────────────────────────────────────────────────────────────
export const generateInviteLink: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const { spaceId, expiresInDays } = req.body ?? {};

        const { created, link } = await inviteLinks.generateInviteLink(routeParam(req, 'id'), user.id, { spaceId, expiresInDays });

        if (!created) {
            res.status(200).json({ success: true, data: link, message: 'Existing invite link returned' });
            return;
        }
        res.status(201).json({ success: true, data: link, message: 'Invite link generated' });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// GET /api/workspaces/invite-link/:token/info
// Public — returns workspace name, space name, creator name
// No auth required (landing page uses this)
// ─────────────────────────────────────────────────────────────
export const getInviteLinkInfo: RequestHandler = async (req, res, next) => {
    try {
        const info = await inviteLinks.getInviteLinkInfo(routeParam(req, 'token'));
        res.status(200).json({ success: true, data: info });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/workspaces/invite-link/:token/request
// Authenticated user requests to join via invite token
// ─────────────────────────────────────────────────────────────
export const requestToJoinViaLink: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        await inviteLinks.requestToJoinViaLink(routeParam(req, 'token'), {
            id: user.id,
            name: user.name,
            email: user.email,
            avatar: user.avatar,
        });
        res.status(200).json({
            success: true,
            message: 'Your request has been sent to the workspace admins. You\'ll be notified once approved.',
        });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/workspaces/:id/invite-link/:linkId
// Revoke an invite link (admin only)
// ─────────────────────────────────────────────────────────────
export const revokeInviteLink: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        await inviteLinks.revokeInviteLink(routeParam(req, 'id'), user.id, routeParam(req, 'linkId'));
        res.status(200).json({ success: true, message: 'Invite link revoked' });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// GET /api/workspaces/:id/invite-links
// Get all active invite links for a workspace (admin only)
// ─────────────────────────────────────────────────────────────
export const getInviteLinks: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const links = await inviteLinks.listInviteLinks(routeParam(req, 'id'), user.id);
        res.status(200).json({
            success: true,
            data: links.map((l) => ({
                _id: l.id,
                token: l.token,
                spaceId: l.spaceId,
                expiresAt: l.expiresAt,
                useCount: l.useCount,
                createdAt: l.createdAt,
            })),
        });
    } catch (err) {
        next(err);
    }
};
