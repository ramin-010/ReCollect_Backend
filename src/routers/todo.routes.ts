import express, { RequestHandler } from 'express';
import { upflyUpload } from 'upfly';
import authMiddleware from '../middlwares/auth';
import { createTodo, getTodos, updateTodo, deleteTodo } from '../controllers/todo.controller';

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
        folder: 'recollect-todos'
      }
    },
  },
});

// All routes require authentication
router.get('/todos', authMiddleware, getTodos as RequestHandler);
router.post('/todos', authMiddleware, upload as RequestHandler, createTodo as RequestHandler);
router.patch('/todos/:id', authMiddleware, updateTodo as RequestHandler);
router.delete('/todos/:id', authMiddleware, deleteTodo as RequestHandler);

export default router;

