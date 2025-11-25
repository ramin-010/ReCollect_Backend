import { Request, Response, NextFunction, CookieOptions } from "express";
import {boolean, number, success, z} from 'zod'
import User,{User as UserType} from '../models/userSchema'
import ErrorResponse from "../utils/errorResponse";
import Dashboard,{Dashboard as DashboardType} from '../models/dashboardSchema'

const userSignupSchema = z.object({
    name : z.string().min(1, {message : 'Name cannot be empty'}),
    email : z.string().email({message : 'email is not valid'}),
    password : z.string().min(8, {message : 'Password must be atleast 8 charachter long'})
});

type UserSignup = z.infer<typeof userSignupSchema>

export const Signup = async (req: Request, res: Response, next: NextFunction) : Promise<any>=> {
   try{
        const result = userSignupSchema.safeParse(req.body)
    
        if(!result.success){
        return res.status(400).json({
                message : 'Invalid Credential',
                error : result.error.flatten()
            })
        }
        const{email , name , password} = result.data as UserSignup ;
        const existingUser = await User.findOne({email}).exec();

        if(existingUser){
            throw new ErrorResponse(400, "User already exists")
        }

        const user = await User.create({
            email,
            name,
            password
        });

    sendTokenResponse(user, 200, res)
   }catch(err : any){
        next(err);
   }
}

const userLoginSchema = z.object({
    email : z.string().email({message: 'email is not valid'}),
    password : z.string().min(8, {message : "password must be atleast 8 character long" })
})

type UserLogin = z.infer<typeof userLoginSchema>

export const login = async(req : Request , res : Response, next : NextFunction) : Promise<any> =>{
    try{
        const result = userLoginSchema.safeParse(req.body);

        if(!result.success){
            return res.status(400).json({
                message : "Invalid credentails",
                error : result.error.flatten()
            })
        }

        const {email , password} = result.data as UserLogin

        const user = await User.findOne({email}).select('+password').exec();
        if(!user){
            throw new ErrorResponse(400, "user does not exist")
        }
        const isMatched = await user.comparePassword(password);
        if(!isMatched) throw new ErrorResponse(400, "wrong password");
        
       
        req.user = user;
        sendTokenResponse(user, 200, res);
    }catch(err : any){
        next(err)
    }
}


export const Getme = async(req : Request, res : Response, next : NextFunction) : Promise<void>=>{
    try{
        const user = req.user as UserType;

        const dashboards = await Dashboard.find({ user: user._id })
        .populate({
            path: 'contents',
            select: 'title body links tags visibility description updatedAt', // include tags field here
            populate: [
                { 
                    path: 'tags',                  // nested populate
                    select: 'name'                 // only select the tag name
                },
                {
                    path : 'body'
                }
            ]
        }) as DashboardType[];

 

        res.status(200).json({
            success : true,
            data : dashboards,
            message : 'get me succeded'
        })
    }catch(err : any){
        next(err)
    }
}





function sendTokenResponse (user : UserType, statusCode : number, res : Response) : void{
    const token = user.getSignedJwtToken();

    // JWT_COOKIE_EXPIRE : number = process.env.JWT_COOKIE_EXPIRE;

    if(!process.env.JWT_COOKIE_EXPIRE){
        throw new ErrorResponse(400, 'JWT_COOKIE_EXPIRE is undefined')
    }
    const JWT_COOKIE_EXPIRE = parseInt(process.env.JWT_COOKIE_EXPIRE);


    const options: CookieOptions = {
        expires: new Date(Date.now() + JWT_COOKIE_EXPIRE * 24 * 60 * 60 * 1000),
        httpOnly: true,
        secure: true,
        sameSite: 'lax'
    }
     const userObj = user.toObject();
  delete userObj.password;

    res.status(statusCode).cookie('token', token, options).json({
        success: true,
        data: userObj
    })
}

export const logout = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    // Clear the token cookie
    res.cookie('token', '', {
      httpOnly: true,
      expires: new Date(0),
      secure: true,
      sameSite: 'none'
    });

    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (err: any) {
    next(err);
  }
};

