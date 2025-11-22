import express,{Request, Response, NextFunction, Application} from 'express'
const app : Application = express();
import morgan from 'morgan';
import cors from 'cors'
import cookieParser from 'cookie-parser';


import ConnectDb from './db/db';
import errorHandler from './middlwares/errorHandler';

app.use(express.json());
app.use(express.urlencoded({extended : true}));
app.use(morgan('dev'));
app.use(cookieParser())

//require('./models');
ConnectDb();



const allowOrigin = [
    'http://localhost:3000',
    'http://localhost:5173'
].filter(Boolean)

app.use(cors({
    origin : (origin , cb) =>{
        if(!origin || allowOrigin.includes(origin)){
            cb(null, true)
        }else{
            cb(new Error('Not allowed by Cors'))
        }
    },
    credentials : true,
    methods : ['GET', "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders : ['Content-Type', "Authorization"]
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

import userRoutes from './routers/user.routes'
app.use('/api', userRoutes);

import reminderRoutes from './routers/reminder.routes'
app.use('/api', reminderRoutes);

app.use(errorHandler);

const PORT = process.env.PORT
app.listen(PORT, ()=>{
    console.log(`Server runnin on : http://localhost:${PORT}`);
})

module.exports = app;









































