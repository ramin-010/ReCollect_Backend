import express from 'express';
const router = express.Router();
import { generateOtp, verifyOtp, generateOtpAuth, generateOtpForEmail } from '../controllers/otp.controller';
import authMiddleware from '../middlwares/auth';

router.post('/otp/generate', generateOtp);
router.post('/otp/verify', verifyOtp);

router.post('/otp/generate-auth', authMiddleware, generateOtpAuth);
router.post('/otp/generate-for-email', authMiddleware, generateOtpForEmail);

export default router;
