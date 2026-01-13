import express from 'express';
const router = express.Router();
import {Getme, Signup, login, logout, preSignup, verifySignup, forgotPassword, resetPassword} from '../controllers/auth.controller'
import authMiddleware from '../middlwares/auth'


router.post('/signup', Signup);
router.post('/login', login)
router.get('/get-me',authMiddleware, Getme)
router.post('/logout', logout)

router.post('/pre-signup', preSignup);
router.post('/verify-signup', verifySignup);

router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);


export default router