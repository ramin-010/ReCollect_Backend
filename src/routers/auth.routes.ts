import express from 'express';
const router = express.Router();
import {Getme, Signup, login, logout, preSignup, verifySignup, forgotPassword, resetPassword, googleLogin} from '../controllers/auth.controller'
import authMiddleware from '../middlwares/auth'
import { doorLimit } from '../middlwares/rateLimit'

// Limits per address and per email (hosting P1-4); one counter per door, shared by its paths.
const loginLimit = doorLimit('login');
const signupLimit = doorLimit('signup');
const resetLimit = doorLimit('reset');
const googleLimit = doorLimit('google');


router.post('/signup', signupLimit, Signup);
router.post('/login', loginLimit, login)
router.get('/get-me',authMiddleware, Getme)
router.post('/logout', logout)

router.post('/pre-signup', signupLimit, preSignup);
router.post('/verify-signup', signupLimit, verifySignup);

router.post('/forgot-password', resetLimit, forgotPassword);
router.post('/reset-password', resetLimit, resetPassword);

// Google OAuth
router.post('/auth/google', googleLimit, googleLogin);


export default router