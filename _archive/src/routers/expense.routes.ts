import { Router } from 'express';
import authMiddleware from '../middlwares/auth';
import {
  getExpenses,
  addExpense,
  deleteExpense,
  getCategories,
  addCategory,
  deleteCategory
} from '../controllers/expense.controller';

const router = Router();

router.get('/', authMiddleware, getExpenses);
router.post('/', authMiddleware, addExpense);
router.delete('/:id', authMiddleware, deleteExpense);

router.get('/categories', authMiddleware, getCategories);
router.post('/categories', authMiddleware, addCategory);
router.delete('/categories/:id', authMiddleware, deleteCategory);

export default router;
