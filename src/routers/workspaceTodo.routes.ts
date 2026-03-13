import express, { RequestHandler } from 'express';
import { upflyUpload } from 'upfly';
import authMiddleware from '../middlwares/auth';
import { createWorkspaceTodo, updateWorkspaceTodo, deleteWorkspaceTodo, getTaskActivity } from '../controllers/workspace/workspaceTodo.controller';
import { assignWorkspaceTask, unassignWorkspaceTask } from '../controllers/workspace/workspaceAssign.controller';

const router = express.Router();

const cloud_name = process.env.CLOUDINARY_CLOUD_NAME || '';
const cloud_key = process.env.CLOUDINARY_API_KEY || '';
const cloud_secret = process.env.CLOUDINARY_API_SECRET || '';

const upload = upflyUpload({
  fields: {
    "image_*": {
      output: 'memory',
      format: 'webp',
      quality: 50,
      cloudStorage: true,
      cloudProvider: "cloudinary",
      cloudConfig: {
        cloud_name: cloud_name,
        api_key: cloud_key,
        api_secret: cloud_secret,
        folder: 'recollect-todos-workspace'
      }
    },
  },
});

// All Workspace Todo routes require authentication
router.post('/', authMiddleware, upload as RequestHandler, createWorkspaceTodo as RequestHandler);
router.patch('/:id', authMiddleware, upload as RequestHandler, updateWorkspaceTodo as RequestHandler);
router.delete('/:id', authMiddleware, deleteWorkspaceTodo as RequestHandler);

// Assignment routes for workspace tasks
router.post('/:id/assign', authMiddleware, assignWorkspaceTask as RequestHandler);
router.post('/:id/unassign', authMiddleware, unassignWorkspaceTask as RequestHandler);

// Activity logs
router.get('/:id/activity', authMiddleware, getTaskActivity as RequestHandler);

export default router;
