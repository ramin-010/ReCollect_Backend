import express, { Request, Response, NextFunction, Application } from 'express'
const app: Application = express();
import morgan from 'morgan';
import cors from 'cors'
import cookieParser from 'cookie-parser';


import ConnectDb from './server/db';
import errorHandler from './middlwares/errorHandler';
import { USE_BULLMQ } from './services/reminderService';
import { startCronScheduler } from './services/cronScheduler';
import { initializeCollaboration, startCollaborationServer } from './collaboration';

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));
app.use(cookieParser())

//require('./models');
ConnectDb();



const allowOrigin = [
    'http://localhost:3005',
    'http://localhost:5173',
    'http://192.168.40.58:3005',
    'https://re-collect.in',
    'https://api.re-collect.in',
    'https://www.re-collect.in'
].filter(Boolean)

app.use(cors({
    origin: (origin, cb) => {
        if (!origin || allowOrigin.includes(origin)) {
            cb(null, true)
        } else {
            cb(new Error('Not allowed by Cors'))
        }
    },
    credentials: true,
    methods: ['GET', "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ['Content-Type', "Authorization"]
}))


import authRouter from './routers/auth.routes'
app.use('/api', authRouter);

import contetnRouter from './routers/content.routes'
app.use('/api', contetnRouter);

import dashRouter from './routers/dash.routes'
app.use('/api', dashRouter);

import shareLinkRouter from './routers/shareLink.routes';
app.use('/api', shareLinkRouter);

import tagQueryRouter from './routers/tagQuery.routes'
app.use('/api', tagQueryRouter)

import otpRoutes from './routers/otp.routes'
app.use('/api', otpRoutes);




import todoRoutes from './routers/todo.routes';
app.use('/api', todoRoutes);


import expenseRoutes from './routers/expense.routes';
app.use('/api/expenses', expenseRoutes);

import userRoutes from './routers/user.routes'
app.use('/api', userRoutes);

import docRoutes from './routers/doc.routes';
app.use('/api/docs', docRoutes);

import drawingRoutes from './routers/drawing.routes';
app.use('/api/drawings', drawingRoutes);

import slideRoutes from './routers/slide.routes';
app.use('/api/slides', slideRoutes);

import slideAiRoutes from './routers/slideAi.routes';
app.use('/api/slides/ai', slideAiRoutes);

import livekitRoutes from './routers/livekit.routes';
app.use('/api/livekit', livekitRoutes);

import uploadRoutes from './routers/upload.routes';
app.use('/api/collab/upload', uploadRoutes);

import emailRoutes from './routers/email.routes';
app.use('/api/email', emailRoutes);




// import reminderRoutes from './routers/reminder.routes'
// app.use('/api', reminderRoutes);

app.use(errorHandler);

// Initialize reminder system based on mode
if (USE_BULLMQ) {
    console.log('📋 Reminder System Mode: BullMQ');
    console.log('⚠️  Make sure to run the worker separately: ts-node src/worker/reminderWorker.ts');
} else {
    console.log('📋 Reminder System Mode: Cron + DB Polling');
    startCronScheduler();
}

const PORT = process.env.PORT
app.listen(PORT, () => {
    console.log(`Server runnin on : http://localhost:${PORT}`);
    
    // Initialize and start collaboration server for real-time editing
    initializeCollaboration();
    startCollaborationServer();
})

module.exports = app;
