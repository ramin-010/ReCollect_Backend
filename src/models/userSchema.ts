import mongoose,{Document, Schema} from "mongoose";
import { maxLength, minLength } from "zod";
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
dotenv.config();


export interface User extends Document{
    name : string,
    email : string,
    password : string,
    avatar ?: string,
  comparePassword(enteredPassword: string): Promise<boolean>;
    getSignedJwtToken() : String
}


const userSchema = new Schema<User>(
    {
        name : {
            type : String,
            required : true,
            trim : true,
            maxLength : 50
        },
        email : {
            type : String,
            required : true,
            trim : true,
            unique : true,
        },
        password : {
            type : String,
            required : true,
            minLength : 6,
            select : false
        },
        avatar : {
            type : String,
            default : '',
        }
    }, 
    {
        timestamps : true
    });


userSchema.pre('save', async function(next){
    if(!this.isModified('password')){
        return next;
    }
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.comparePassword = async function(pass : string) : Promise<boolean>{
   return await bcrypt.compare(pass, this.password);
}

userSchema.methods.getSignedJwtToken = function() : string{
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is not defined in environment variables');
    }
    
    return jwt.sign(
        { id: this._id },
        process.env.JWT_SECRET,
        {
            expiresIn: process.env.JWT_EXPIRE || '30d' 
        } as jwt.SignOptions
    );
}


export default mongoose.model<User>('User', userSchema);