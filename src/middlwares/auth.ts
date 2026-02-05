import { Request, Response, NextFunction } from "express"
import ErrorResponse from "../utils/errorResponse";
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
dotenv.config();

import User from '../models/userSchema'

const authMiddleware = async (req: Request, res: Response, next: NextFunction) : Promise<void>=> {
    console.log("this is auth middleware")
    try {
        const token = req.cookies?.token;

        //console.log("this is toek", token)
        if (!token) {
            throw new ErrorResponse(401, "Not authorized, no token found");
        }

        if (!process.env.JWT_SECRET) {
            throw new ErrorResponse(400, "JWT_SECRET is not defined in environment variables");
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET) as { id: string };
        const user = await User.findById(decoded.id).select('-password');

        if (!user) {
            throw new ErrorResponse(404, "User not found");
        }

        req.user = user;
        next();
    } catch (err : any) {
        if(err.name === 'JsonWebTokenError'){
            return next(new ErrorResponse(404, "Invalid token"))
        }
        if(err.name === 'TokenExpiredError'){
            return next()
        }
        next(err);
    }
};

export default authMiddleware;