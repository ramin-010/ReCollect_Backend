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
    phone ?: string,
    avatar ?: string,
    reminderEmail ? : string,
    archivedNotes?: string[],
    cloudPublicId?: string,
    cloudProvider?: string,
    favoriteNotes?: string[]
    // Google OAuth
    googleId?: string;
    authProvider?: 'local' | 'google';
    // Gmail API
    gmailConnected?: boolean;
    gmailRefreshToken?: string;
    gmailEmail?: string;
    // Ghost/Shadow User Support
    status?: 'active' | 'pending';
    isGhost?: boolean;

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
        reminderEmail : {
            type : String,
            trim : true,
            unique : true,
            sparse : true
        },
        phone : {
            type : String,
            trim : true,
            default: ''
        },
        password : {
            type : String,
            required : false,
            minLength : 6,
            select : false
        },
        avatar : {
            type : String,
            default : '',
        },
        archivedNotes: [{
            type: Schema.Types.ObjectId,
            ref: 'Content'
        }],
        favoriteNotes: [{
            type: Schema.Types.ObjectId,
            ref: 'Content'
        }],
        cloudPublicId : {
            type : String,
            default: '',
            required: false,
        },
        cloudProvider : {
            type : String,
            default: '',
            required: false,
        },
        // Ghost User Props
        status: {
            type: String,
            enum: ['active', 'pending'],
            default: 'active'
        },
        isGhost: {
            type: Boolean,
            default: false
        },
        googleId: {
            type: String,
            default: '',
            sparse: true
        },
        authProvider: {
            type: String,
            enum: ['local', 'google'],
            default: 'local'
        },
        // Gmail API fields
        gmailConnected: {
            type: Boolean,
            default: false
        },
        gmailRefreshToken: {
            type: String,
            default: ''
        },
        gmailEmail: {
            type: String,
            default: ''
        }
    }, 
    {
        timestamps : true
    });


userSchema.pre('save', async function(next){
    if(!this.reminderEmail){
        this.reminderEmail = this.email;
    }
    if(!this.isModified('password')){
        return next();
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