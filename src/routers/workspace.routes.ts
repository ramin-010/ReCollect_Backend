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
} from '../controllers/workspace.controller';

const router = Router();

// All workspace routes require auth
router.use(authMiddleware as RequestHandler);

router.post('/', createWorkspace);
router.get('/', getWorkspaces);
router.get('/:id', getWorkspace);
router.post('/:id/members', inviteMember);
router.delete('/:id/members/:userId', removeMember);
router.patch('/:id/members/:userId/role', updateWorkspaceRole);
router.delete('/:id', deleteWorkspace);

// New: workspace-scoped data endpoints
router.post('/:id/spaces', createSpace);
router.get('/:id/tasks', getWorkspaceTasks);
router.get('/:id/stats', getWorkspaceStats);
router.get('/:id/activity', getWorkspaceActivity);
router.patch('/:id/settings', updateWorkspaceSettings);

export default router;
