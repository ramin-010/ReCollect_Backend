import mongoose, { Document, Schema } from "mongoose";

export interface SignupData {
    name: string;
    password: string;
}

export interface OTP extends Document {
    email: string;
    otp: string;
    createdAt: Date;
    signupData?: SignupData;
    purpose: 'signup' | 'password-reset';
}

const otpSchema = new Schema<OTP>({
    email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        index: true
    },
    otp: {
        type: String,
        required: true,
        length: 4
    },
    signupData: {
        name: { type: String },
        password: { type: String }
    },
    purpose: {
        type: String,
        enum: ['signup', 'password-reset'],
        default: 'signup'
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 180 // TTL index: auto-delete after 180 seconds (3 minutes)
    }
});

export default mongoose.model<OTP>('OTP', otpSchema);
