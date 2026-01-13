import express from 'express';
const router = express.Router();
import { generateOtp, verifyOtp, generateOtpAuth } from '../controllers/otp.controller';
import authMiddleware from '../middlwares/auth';

router.post('/otp/generate', generateOtp);
router.post('/otp/verify', verifyOtp);

router.post('/otp/generate-auth', authMiddleware, generateOtpAuth);

export default router;
