import express from 'express';
import multer from 'multer';
import authMiddleware from '../middlwares/auth';
import {
    connectGmail,
    gmailCallback,
    gmailStatus,
    disconnectGmail,
    generateDraft,
    sendEmailController,
    getTrackedThreads,
    getThreadDetail,
    archiveThread,
} from '../controllers/email.controller';

const router = express.Router();

// Multer — memory storage for email attachments (max 5 files, 10MB each)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 5 },
});

// Gmail OAuth
router.post('/connect', authMiddleware, connectGmail);
router.post('/callback', authMiddleware, gmailCallback);
router.get('/status', authMiddleware, gmailStatus);
router.post('/disconnect', authMiddleware, disconnectGmail);

// AI Draft
router.post('/draft', authMiddleware, generateDraft);

// Send & Threads — upload.array('attachments') for file uploads
router.post('/send', authMiddleware, upload.array('attachments'), sendEmailController);
router.get('/threads', authMiddleware, getTrackedThreads);
router.get('/threads/:threadId', authMiddleware, getThreadDetail);
router.patch('/threads/:threadId/archive', authMiddleware, archiveThread);

export default router;
