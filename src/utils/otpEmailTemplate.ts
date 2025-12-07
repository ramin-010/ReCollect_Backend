// OTP Email Template for sending verification codes
import nodemailer from 'nodemailer';

// Create reusable transporter
const createTransporter = () => {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD
        }
    });
};

export const sendOtpEmail = async (
    email: string,
    otp: string
): Promise<boolean> => {
    try {
        const transporter = createTransporter();

        const mailOptions = {
            from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
            to: email,
            subject: `🔐 Your Verification Code: ${otp}`,
            html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Verification Code</title>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
            <style>
              /* Reset & Base */
              * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
              }
              body {
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                background-color: #f3f4f6;
                color: #1f2937;
                line-height: 1.6;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
              }

              /* Layout */
              .email-wrapper {
                background-color: #f3f4f6;
                padding: 48px 20px;
                min-height: 100vh;
              }
              .email-container {
                max-width: 480px;
                margin: 0 auto;
                background: #ffffff;
                border-radius: 16px;
                overflow: hidden;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04);
              }

              /* Header */
              .header {
                background: #ffffff;
                padding: 40px 40px 24px;
                text-align: center;
              }
              .logo-img {
                height: 60px;
                width: auto;
                display: block;
                margin: 0 auto 16px;
              }
              .header-title {
                font-size: 22px;
                font-weight: 700;
                color: #111827;
                margin-bottom: 8px;
                letter-spacing: -0.02em;
              }
              .header-subtitle {
                font-size: 15px;
                color: #6b7280;
                font-weight: 400;
              }

              /* Content */
              .content {
                padding: 0 40px 40px;
                text-align: center;
              }

              /* OTP Box */
              .otp-container {
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                border-radius: 16px;
                padding: 32px;
                margin: 24px 0;
              }
              .otp-label {
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 1.5px;
                color: #9ca3af;
                font-weight: 600;
                margin-bottom: 16px;
              }
              .otp-code {
                font-size: 42px;
                font-weight: 700;
                letter-spacing: 12px;
                color: #ffffff;
                font-family: 'Courier New', monospace;
                text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
              }

              /* Warning */
              .warning-box {
                background: #fef3c7;
                border: 1px solid #fcd34d;
                border-radius: 10px;
                padding: 14px 18px;
                margin-top: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
              }
              .warning-icon {
                font-size: 16px;
              }
              .warning-text {
                font-size: 13px;
                color: #92400e;
                font-weight: 500;
              }

              /* Info */
              .info-text {
                font-size: 14px;
                color: #6b7280;
                margin-top: 24px;
                line-height: 1.6;
              }

              /* Footer */
              .footer {
                padding: 24px;
                background: #f9fafb;
                border-top: 1px solid #f3f4f6;
                text-align: center;
              }
              .footer-text {
                color: #9ca3af;
                font-size: 12px;
                line-height: 1.6;
              }

              /* Mobile */
              @media only screen and (max-width: 500px) {
                .email-wrapper {
                  padding: 16px;
                }
                .content, .header {
                  padding-left: 24px;
                  padding-right: 24px;
                }
                .otp-code {
                  font-size: 36px;
                  letter-spacing: 8px;
                }
              }
            </style>
          </head>
          <body>
            <div class="email-wrapper">
              <div class="email-container">
                <div class="header">
                  <img src="https://res.cloudinary.com/dsfb3jjqx/image/upload/v1763902793/recollect/yg9aexn9iwtxmun5du4d.png" alt="ReCollect" class="logo-img" style="background-color:white; border-radius: 4px;" />
                  <h1 class="header-title">Verification Code</h1>
                  <p class="header-subtitle">Use this code to verify your identity</p>
                </div>
                
                <div class="content">
                  <div class="otp-container">
                    <div class="otp-label">Your OTP Code</div>
                    <div class="otp-code">${otp}</div>
                  </div>
                  
                  <div class="warning-box">
                    <span class="warning-icon">⏱️</span>
                    <span class="warning-text">This code expires in 3 minutes</span>
                  </div>
                  
                  <p class="info-text">
                    If you didn't request this code, please ignore this email. 
                    Do not share this code with anyone.
                  </p>
                </div>
                
                <div class="footer">
                  <p class="footer-text">
                    © ${new Date().getFullYear()} ReCollect. All rights reserved.
                  </p>
                </div>
              </div>
            </div>
          </body>
        </html>
      `
        };

        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('Failed to send OTP email:', error);
        return false;
    }
};
