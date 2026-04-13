import { Request, Response, NextFunction } from "express";
import { z } from 'zod';
import OTP from '../models/otpSchema';
import { sendOtpEmail } from '../utils/otpEmailTemplate';
import ErrorResponse from "../utils/errorResponse";

const generateOtpSchema = z.object({
    email: z.string().email({ message: 'Please provide a valid email address' })
});

const verifyOtpSchema = z.object({
    email: z.string().email({ message: 'Please provide a valid email address' }),
    otp: z.string().length(4, { message: 'OTP must be exactly 4 digits' })
});

export const generateUniqueOtp = (): string => {
    return Math.floor(1000 + Math.random() * 9000).toString();
};

export const createAndSendOtp = async (email: string, purpose: 'signup' | 'password-reset', signupData?: { name: string; password: string }): Promise<boolean> => {
    await OTP.deleteMany({ email: email.toLowerCase() });
    
    const otp = generateUniqueOtp();
    
    await OTP.create({
        email: email.toLowerCase(),
        otp,
        purpose,
        signupData
    });
    
    return await sendOtpEmail(email, otp); 
};

export const verifyOtpInternal = async (email: string, otp: string, purpose?: 'signup' | 'password-reset') => {
    const query: any = { email: email.toLowerCase() };
    if (purpose) query.purpose = purpose;
    
    const storedOtp = await OTP.findOne(query);
    
    if (!storedOtp) {
        throw new ErrorResponse(400, 'OTP has expired or does not exist. Please request a new one.');
    }
    
    if (storedOtp.otp !== otp) {
        throw new ErrorResponse(400, 'Invalid OTP. Please check and try again.');
    }
    
    return storedOtp;
};

export const deleteOtp = async (otpId: string) => {
    await OTP.deleteOne({ _id: otpId });
};

export const generateOtp = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const result = generateOtpSchema.safeParse(req.body);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request',
                error: result.error.flatten()
            });
        }

        const { email } = result.data;
        const emailSent = await createAndSendOtp(email, 'signup');

        if (!emailSent) {
            throw new ErrorResponse(500, 'Failed to send OTP email. Please try again.');
        }

        res.status(200).json({
            success: true,
            message: 'OTP sent successfully to your email'
        });

    } catch (err: any) {
        next(err);
    }
};

export const verifyOtp = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const result = verifyOtpSchema.safeParse(req.body);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request',
                error: result.error.flatten()
            });
        }

        const { email, otp } = result.data;
        const storedOtp = await verifyOtpInternal(email, otp);
        await deleteOtp(storedOtp._id as string);

        res.status(200).json({
            success: true,
            message: 'OTP verified successfully'
        });

    } catch (err: any) {
        next(err);
    }
};

export const generateOtpAuth = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const user = req.user;
        
        if (!user || !user.email) {
            throw new ErrorResponse(401, 'User not authenticated');
        }

        const email = user.email;
        const emailSent = await createAndSendOtp(email, 'password-reset');

        if (!emailSent) {
            throw new ErrorResponse(500, 'Failed to send OTP email. Please try again.');
        }

        res.status(200).json({
            success: true,
            message: 'OTP sent successfully to your registered email'
        });

    } catch (err: any) {
        next(err);
    }
};

export const generateOtpForEmail = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const user = req.user;
        
        if (!user || !user.email) {
            throw new ErrorResponse(401, 'User not authenticated');
        }

        const { email } = req.body;
        if (!email || typeof email !== 'string') {
            throw new ErrorResponse(400, 'Please provide a valid email address');
        }

        const emailSent = await createAndSendOtp(email.toLowerCase(), 'password-reset');

        if (!emailSent) {
            throw new ErrorResponse(500, 'Failed to send OTP email. Please try again.');
        }

        res.status(200).json({
            success: true,
            message: `OTP sent successfully to ${email}`
        });

    } catch (err: any) {
        next(err);
    }
};
