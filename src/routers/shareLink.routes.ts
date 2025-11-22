import {createContentShareLink, createDashShareLink, fetchContentLink, fetchDashLink} from '../controllers/shareLink.controller';
import authMiddleware from '../middlwares/auth'
import express from 'express';
const router = express.Router();


router.post('/create-content-link',authMiddleware, createContentShareLink);
router.post('/create-dash-link',authMiddleware, createDashShareLink);
router.get('/content/:slug', fetchContentLink);
router.get('/dashboard/:slug', fetchDashLink);


export default router;