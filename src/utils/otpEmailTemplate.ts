// OTP Email Template for sending verification codes
import { createMailTransport } from './mailTransport';

// Create reusable transporter (Gmail; EMAIL_DELIVERY=off drops every message: ./mailTransport)
const createTransporter = () => createMailTransport();

export const sendOtpEmail = async (
    email: string,
    otp: string
): Promise<boolean> => {
    try {
        const transporter = createTransporter();
        const LOGO_LIGHT_URL = 'https://kaaga.in/icons/icon-192.png';
        const LOGO_DARK_URL = 'https://kaaga.in/icons/icon-192.png';
        
        const TEXT_BLACK = '#37352f';
        const TEXT_GRAY = '#787774';
        const BORDER_COLOR = '#e4e4e7';

        const logoBlock = (size: number = 24): string => `
<img src="${LOGO_LIGHT_URL}" class="logo-light" alt="Kaaga" width="${size}" height="${size}" style="display: block;" />
<!--[if !mso]><!--><img src="${LOGO_DARK_URL}" class="logo-dark" alt="Kaaga" width="${size}" height="${size}" style="display: none;" /><!--<![endif]-->`;

        const avatarBlock = (name: string, size: number = 24): string => {
            const initial = name ? name.charAt(0).toUpperCase() : 'K';
            return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: ${size}px; height: ${size}px; background-color: #ededed; border-radius: 4px; border: 1px solid #e1e1e1;"><tr><td align="center" valign="middle" style="font-size: ${Math.floor(size * 0.6)}px; font-weight: 600; color: #37352f; line-height: 1; padding-bottom: 2px;">${initial}</td></tr></table>`;
        };

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

        const mailOptions = {
            from: `"Kaaga" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
            to: email,
            subject: `Login Code: ${otp}`,
            html: `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <style>
      .logo-dark { display: none !important; }
      @media (prefers-color-scheme: dark) {
        .logo-light { display: none !important; }
        .logo-dark { display: block !important; }
      }
      [data-ogsc] .logo-light { display: none !important; }
      [data-ogsc] .logo-dark { display: block !important; }
      a { text-decoration: none; }
    </style>
  </head>
  <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, 'Apple Color Emoji', Arial, sans-serif, 'Segoe UI Emoji', 'Segoe UI Symbol'; background-color: #ffffff; -webkit-font-smoothing: antialiased; color: ${TEXT_BLACK};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff;">
      <tr>
        <td align="center" style="padding: 48px 20px;">
          <!-- Left aligned, max-width 600px -->
          <table role="presentation" cellspacing="0" cellpadding="0" style="max-width: 600px; width: 100%; border: none;">
            
            <!-- Header -->
            <tr>
              <td style="padding-bottom: 40px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding-right: 12px;">
                      ${avatarBlock('Kaaga', 24)}
                    </td>
                    <td valign="middle">
                      <span style="font-size: 16px; font-weight: 600; color: ${TEXT_GRAY}; letter-spacing: -0.01em;">Kaaga</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Main Content -->
            <tr>
              <td align="left" style="padding-bottom: 32px;">
                <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: ${TEXT_BLACK}; line-height: 1.25; letter-spacing: -0.02em;">Login code</h1>
                <p style="margin: 0 0 24px; font-size: 15px; color: ${TEXT_GRAY}; line-height: 1.6;">Here is your verification code. It will expire in 3 minutes.</p>

                <div style="margin: 0 0 32px; padding: 16px 20px; border: 1px solid ${BORDER_COLOR}; border-radius: 6px; display: inline-block;">
                  <span style="font-size: 28px; font-weight: 700; letter-spacing: 4px; color: ${TEXT_BLACK}; font-family: 'SF Mono', 'Fira Code', 'Roboto Mono', 'Courier New', monospace;">${otp}</span>
                </div>

                <p style="margin: 0; font-size: 13px; color: #a1a1aa; line-height: 1.5;">If you did not request this login code, you can safely ignore this email.</p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="left" style="padding-top: 24px; border-top: 1px solid ${BORDER_COLOR};">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td valign="top" style="padding-right: 16px; padding-top: 0px;">
                      ${logoBlock(48)}
                    </td>
                    <td valign="top">
                      <p style="margin: 0 0 4px; font-size: 16px; font-weight: 600; color: ${TEXT_BLACK};">Kaaga</p>
                      <p style="margin: 0; font-size: 15px; color: #a1a1aa; line-height: 1.4;">
                        <span style="color: #787774; border-bottom: 1px solid #d4d4d8;">kaaga.in</span>, one memory for all your AIs<br />
                        for docs, projects, and wikis.
                      </p>
                      <div style="margin-top: 12px;">
                        <span style="color: #9ca3af; font-size: 14px;">&copy; ${new Date().getFullYear()} Kaaga</span>
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
        };

        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('Failed to send OTP email:', error);
        return false;
    }
};
