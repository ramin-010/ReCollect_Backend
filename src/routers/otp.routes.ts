import express from 'express';
const router = express.Router();
import { generateOtp, verifyOtp, generateOtpAuth } from '../controllers/otp.controller';
import authMiddleware from '../middlwares/auth';

// OTP Routes - can be reused for various purposes (auth, password reset, etc.)
router.post('/otp/generate', generateOtp);
router.post('/otp/verify', verifyOtp);

// Authenticated OTP generation (for password change - extracts email from logged in user)
router.post('/otp/generate-auth', authMiddleware, generateOtpAuth);

export default router;
