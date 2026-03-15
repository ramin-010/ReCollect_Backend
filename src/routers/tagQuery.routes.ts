import { tagSearchQuery } from "../controllers/tagQuery.controller";
import authMiddleware from '../middlwares/auth'
import express from 'express';
const router = express.Router();


router.get('/tagQuery/search', authMiddleware, tagSearchQuery)

export default router