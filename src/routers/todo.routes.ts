import express from 'express';
import authMiddleware from '../middlwares/auth';
import { 
    getTodos, 
    createTodo, 
    updateTodo, 
    deleteTodo 
} from '../controllers/todo.controller';

const router = express.Router();

// All routes require authentication
router.get('/todos', authMiddleware, getTodos);
router.post('/todos', authMiddleware, createTodo);
router.patch('/todos/:id', authMiddleware, updateTodo);
router.delete('/todos/:id', authMiddleware, deleteTodo);

export default router;
