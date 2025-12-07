import { Request, Response, NextFunction } from "express";
import { z } from 'zod';
import OTP from '../models/otpSchema';
import { sendOtpEmail } from '../utils/otpEmailTemplate';
import ErrorResponse from "../utils/errorResponse";

// Validation schemas
const generateOtpSchema = z.object({
    email: z.string().email({ message: 'Please provide a valid email address' })
});

const verifyOtpSchema = z.object({
    email: z.string().email({ message: 'Please provide a valid email address' }),
    otp: z.string().length(4, { message: 'OTP must be exactly 4 digits' })
});

/**
 * Generate a unique 4-digit OTP
 */
const generateUniqueOtp = (): string => {
    return Math.floor(1000 + Math.random() * 9000).toString();
};

/**
 * @desc    Generate and send OTP to user's email
 * @route   POST /api/otp/generate
 * @access  Public
 */
export const generateOtp = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        
        
        // Validate request body
        const result = generateOtpSchema.safeParse(req.body);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request',
                error: result.error.flatten()
            });
        }

        const { email } = result.data;

        // Delete any existing OTP for this email
        await OTP.deleteMany({ email: email.toLowerCase() });

        // Generate new 4-digit OTP
        const otp = generateUniqueOtp();

        // Store OTP in database (will auto-expire in 3 minutes due to TTL index)
        await OTP.create({
            email: email.toLowerCase(),
            otp
        });

        // Send OTP via email
        const emailSent = await sendOtpEmail(email, otp);

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

/**
 * @desc    Verify OTP
 * @route   POST /api/otp/verify
 * @access  Public
 */
export const verifyOtp = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        // Validate request body
        const result = verifyOtpSchema.safeParse(req.body);
        
        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request',
                error: result.error.flatten()
            });
        }

        const { email, otp } = result.data;

        // Find OTP in database
        const storedOtp = await OTP.findOne({ 
            email: email.toLowerCase() 
        });

        // Check if OTP exists (not expired)
        if (!storedOtp) {
            throw new ErrorResponse(400, 'OTP has expired or does not exist. Please request a new one.');
        }

        // Verify OTP matches
        if (storedOtp.otp !== otp) {
            throw new ErrorResponse(400, 'Invalid OTP. Please check and try again.');
        }

        // Delete OTP after successful verification (one-time use)
        await OTP.deleteOne({ _id: storedOtp._id });

        res.status(200).json({
            success: true,
            message: 'OTP verified successfully'
        });

    } catch (err: any) {
        next(err);
    }
};

/**
 * @desc    Generate and send OTP to authenticated user's email (for password change)
 * @route   POST /api/otp/generate-auth
 * @access  Private (requires auth token)
 */
export const generateOtpAuth = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        // Get email from authenticated user
        const user = req.user;
        
        if (!user || !user.email) {
            throw new ErrorResponse(401, 'User not authenticated');
        }

        const email = user.email;

        // Delete any existing OTP for this email
        await OTP.deleteMany({ email: email.toLowerCase() });

        // Generate new 4-digit OTP
        const otp = generateUniqueOtp();

        // Store OTP in database (will auto-expire in 3 minutes due to TTL index)
        await OTP.create({
            email: email.toLowerCase(),
            otp
        });

        // Send OTP via email
        const emailSent = await sendOtpEmail(email, otp);

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
