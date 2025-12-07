import { Router } from 'express';
import authMiddleware from '../middlwares/auth';
import {
  getDocs,
  getDoc,
  createDoc,
  updateDoc,
  deleteDoc
} from '../controllers/doc.controller';

const router = Router();

router.get('/', authMiddleware, getDocs);
router.get('/:id', authMiddleware, getDoc);
router.post('/', authMiddleware, createDoc);
router.patch('/:id', authMiddleware, updateDoc);
router.delete('/:id', authMiddleware, deleteDoc);

export default router;
