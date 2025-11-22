import express from 'express';
const router = express.Router();
import {Getme, Signup, login, logout} from '../controllers/auth.controller'
import authMiddleware from '../middlwares/auth'


router.post('/signup', Signup);
router.post('/login', login)
router.get('/get-me',authMiddleware, Getme)
router.post('/logout', logout)


export default router