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
        const logoUrl = 'https://res.cloudinary.com/dsfb3jjqx/image/upload/v1765101198/recollect/pyf5tmicuidnxtmi76e5.png';
        const TEXT_BLACK = '#0f0f0f';
        const TEXT_GRAY = '#6b7280';
        const BORDER_COLOR = '#ebebeb';
        const NOTION_BLUE = '#2383e2';

        const mailOptions = {
            from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
            to: email,
            subject: `Login Code: ${otp}`,
            html: `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #ffffff; -webkit-font-smoothing: antialiased; color: ${TEXT_BLACK};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff;">
      <tr>
        <td align="center" style="padding: 40px 20px;">
          <!-- Left aligned, max-width 600px -->
          <table role="presentation" cellspacing="0" cellpadding="0" style="max-width: 600px; width: 100%; border: none;">
            
            <!-- Header Logo Row -->
            <tr>
              <td style="padding-bottom: 24px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding-right: 8px;">
                      <img src="${logoUrl}" alt="ReCollect Logo" width="20" height="20" style="display: block; border-radius: 4px;" />
                    </td>
                    <td>
                      <span style="font-size: 14px; font-weight: 500; color: ${TEXT_GRAY}; letter-spacing: -0.01em;">ReCollect Workspace</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Main Content -->
            <tr>
              <td align="left" style="padding-bottom: 40px;">
                <h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: ${TEXT_BLACK}; line-height: 1.25; letter-spacing: -0.02em;">Login code</h1>
                <p style="margin: 0 0 24px; font-size: 15px; color: ${TEXT_GRAY}; line-height: 1.6;">Here is your verification code. It will expire in 3 minutes.</p>

                <div style="margin: 0 0 32px; padding: 16px 20px; border: 1px solid ${BORDER_COLOR}; border-radius: 6px; display: inline-block;">
                  <span style="font-size: 28px; font-weight: 700; letter-spacing: 4px; color: ${TEXT_BLACK}; font-family: 'SF Mono', 'Fira Code', 'Roboto Mono', 'Courier New', monospace;">${otp}</span>
                </div>

                <p style="margin: 0; font-size: 13px; color: #a3a3a3; line-height: 1.5;">If you did not request this login code, you can safely ignore this email.</p>
              </td>
            </tr>

            <!-- Notion Style Footer -->
            <tr>
              <td align="left" style="padding-top: 24px; border-top: 1px solid ${BORDER_COLOR};">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td style="padding-bottom: 12px;">
                      <img src="${logoUrl}" alt="ReCollect" width="24" height="24" style="display: block; border-radius: 4px;" />
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <p style="margin: 0 0 4px; font-size: 12px; color: #a3a3a3; font-weight: 500;">ReCollect</p>
                      <p style="margin: 0; font-size: 11px; color: #a3a3a3; line-height: 1.5;">
                        Your connected workspace for docs, projects, and wikis.<br />
                        &copy; ${new Date().getFullYear()} ReCollect
                      </p>
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
