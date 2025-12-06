import {createDash, updateDash, DeletDash, getDashboardContents} from '../controllers/dashboard.controller';
import authMiddleware from '../middlwares/auth'
import express from 'express';
const router = express.Router();


router.post('/create-dash', authMiddleware, createDash);
router.patch('/update-dash/:id', authMiddleware, updateDash);
router.delete('/delete-dash/:id', authMiddleware, DeletDash);
router.get('/dashboard/:id/contents', authMiddleware, getDashboardContents);


export default router;