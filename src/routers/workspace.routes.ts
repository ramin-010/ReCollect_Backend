import { Router, RequestHandler } from 'express';
import authMiddleware from '../middlwares/auth';
import {
    createWorkspace,
    getWorkspaces,
    getWorkspace,
    inviteMember,
    removeMember,
    deleteWorkspace,
    getWorkspaceTasks,
    getWorkspaceStats,
    getWorkspaceActivity,
    createSpace,
    updateWorkspaceSettings,
    updateWorkspaceRole
} from '../controllers/workspace/workspace.controller';
import {
    generateInviteLink,
    getInviteLinkInfo,
    requestToJoinViaLink,
    revokeInviteLink,
    getInviteLinks,
} from '../controllers/workspace/workspaceInviteLink.controller';

// ── Public router (no auth) ──
// Must be a SEPARATE router so Express v5's router.use(authMiddleware) on the
// protected router never intercepts these routes.
export const publicWorkspaceRouter = Router();
publicWorkspaceRouter.get('/invite-link/:token/info', getInviteLinkInfo as RequestHandler);

// ── Protected router (auth required) ──
const router = Router();
router.use(authMiddleware as RequestHandler);

router.post('/', createWorkspace);
router.get('/', getWorkspaces);
router.get('/:id', getWorkspace);
router.post('/:id/members', inviteMember);
router.delete('/:id/members/:userId', removeMember);
router.patch('/:id/members/:userId/role', updateWorkspaceRole);
router.delete('/:id', deleteWorkspace);

// Workspace-scoped data endpoints
router.post('/:id/spaces', createSpace);
router.get('/:id/tasks', getWorkspaceTasks);
router.get('/:id/stats', getWorkspaceStats);
router.get('/:id/activity', getWorkspaceActivity);
router.patch('/:id/settings', updateWorkspaceSettings);

// Invite link endpoints (auth required)
router.post('/:id/invite-link', generateInviteLink);
router.get('/:id/invite-links', getInviteLinks);
router.delete('/:id/invite-link/:linkId', revokeInviteLink);
router.post('/invite-link/:token/request', requestToJoinViaLink);

export default router;
