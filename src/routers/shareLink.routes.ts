import {createDocShareLink, fetchDocLink, saveSharedDoc} from '../controllers/shareLink.controller';
import authMiddleware from '../middlwares/auth'
import express from 'express';
const router = express.Router();

// Content, dashboard and slide share links were cut (create-content-link, create-dash-link,
// create-slide-link, /content/:slug, /dashboard/:slug, /slide/:slug). Doc sharing is unchanged.
router.post('/create-doc-link', authMiddleware, createDocShareLink);
router.post('/save/:slug', authMiddleware, saveSharedDoc);
router.get('/doc/:slug', fetchDocLink);


export default router;
