import {createContentShareLink, createDashShareLink, fetchContentLink, fetchDashLink, createDocShareLink, fetchDocLink, saveSharedDoc} from '../controllers/shareLink.controller';
import authMiddleware from '../middlwares/auth'
import express from 'express';
const router = express.Router();


router.post('/create-content-link',authMiddleware, createContentShareLink);
router.post('/create-dash-link',authMiddleware, createDashShareLink);
router.post('/create-doc-link', authMiddleware, createDocShareLink);
router.post('/save/:slug', authMiddleware, saveSharedDoc);
router.get('/content/:slug', fetchContentLink);
router.get('/dashboard/:slug', fetchDashLink);
router.get('/doc/:slug', fetchDocLink);


export default router;