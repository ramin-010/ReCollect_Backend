// OTP endpoints (Postgres). Logic lives in src/services/auth/otp.service.ts.
import { Request, Response, NextFunction } from "express";
import { z } from 'zod';
import ErrorResponse from "../utils/errorResponse";
import { createAndSendOtp, deleteOtp, verifyOtp as verifyOtpCode } from '../services/auth/otp.service';

const generateOtpSchema = z.object({
    email: z.string().email({ message: 'Please provide a valid email address' })
});

const verifyOtpSchema = z.object({
    email: z.string().email({ message: 'Please provide a valid email address' }),
    otp: z.string().length(6, { message: 'The code is 6 digits' })
});

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
        const storedOtp = await verifyOtpCode(email, otp);
        await deleteOtp(storedOtp.id);

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

        const { email } = req.body ?? {};
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
