import express from 'express';
const router = express.Router();
import { generateOtp, verifyOtp, generateOtpAuth, generateOtpForEmail } from '../controllers/otp.controller';
import authMiddleware from '../middlwares/auth';
import { doorLimit } from '../middlwares/rateLimit';

const codeLimit = doorLimit('code'); // hosting P1-4

router.post('/otp/generate', codeLimit, generateOtp);
router.post('/otp/verify', codeLimit, verifyOtp);

router.post('/otp/generate-auth', authMiddleware, generateOtpAuth);
router.post('/otp/generate-for-email', authMiddleware, generateOtpForEmail);

export default router;
