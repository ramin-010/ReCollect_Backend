// Email Service for Sending Reminders
import nodemailer from 'nodemailer';
import { Reminder } from '../models/reminderSchema';
import { User } from '../models/userSchema';
import { Content } from '../models/contentSchema';

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

export const sendReminderEmail = async (
  user: any,
  content: any,
  reminder: any
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const logoUrl = 'https://res.cloudinary.com/dsfb3jjqx/image/upload/v1765101198/recollect/pyf5tmicuidnxtmi76e5.png';

    const mailOptions = {
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: user.email,
      subject: `Reminder: ${content.title}`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Note Reminder</title>
          </head>
          <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              <tr>
                <td align="center" style="padding:0px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 500px;">
                    
                    <!-- Dark Header with White Logo -->
                    <tr>
                      <td style="background-color: #111827; padding: 10px 20px;">
                        <img src="${logoUrl}" alt="ReCollect" height="70" style="display: block;" />
                      </td>
                    </tr>

                    <!-- White Content Area -->
                    <tr>
                      <td style="background-color: #ffffff; padding: 32px;">
                        <p style="margin: 0 0 8px; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">
                          Note Reminder
                        </p>
                        <h1 style="margin: 0 0 16px; font-size: 20px; font-weight: 600; color: #111827; line-height: 1.4;">
                          ${content.title}
                        </h1>
                        
                        <!-- Reminder Message -->
                        <p style="margin: 0 0 16px; font-size: 15px; color: #6b7280; line-height: 1.5;">
                          Hi ${user.name}, ${reminder.message || 'you asked to be reminded about this note.'}
                        </p>
                        
                        <!-- Note Description Preview -->
                        ${content.description ? `
                        <div style="margin: 0 0 24px; padding: 12px 16px; background-color: #f9fafb; border-left: 3px solid #111827; border-radius: 0 6px 6px 0;">
                          <p style="margin: 0; font-size: 14px; color: #4b5563; line-height: 1.5; font-style: italic;">
                            ${content.description.substring(0, 200)}${content.description.length > 200 ? '...' : ''}
                          </p>
                        </div>
                        ` : ''}
                        
                        <a href="${frontendUrl}/dashboard/${content.DashId}?note=${content._id}" 
                           style="display: inline-block; background-color: #111827; color: #ffffff; text-decoration: none; padding: 12px 24px; font-size: 14px; font-weight: 500; border-radius: 6px;">
                          View Note
                        </a>
                      </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                      <td style="background-color: #ffffff; padding: 24px 32px; border-top: 1px solid #e5e5e5; border-radius: 0 0 8px 8px;">
                        <p style="margin: 0; font-size: 12px; color: #9ca3af; line-height: 1.5;">
                          ReCollect · <a href="${frontendUrl}/dashboard" style="color: #9ca3af; text-decoration: none;">Manage notifications</a>
                        </p>
                      </td>
                    </tr>

                  </table>
                </td>
              </tr>
            </table>
          </body>
        </html>
      `
    };

    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Failed to send reminder email:', error);
    return false;
  }
};


// Email template for welcome emails
export const sendWelcomeEmail = async (user: any): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const logoUrl = 'https://res.cloudinary.com/dsfb3jjqx/image/upload/v1765101198/recollect/pyf5tmicuidnxtmi76e5.png';

    const mailOptions = {
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: user.email,
      subject: 'Welcome to ReCollect',
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Welcome to ReCollect</title>
          </head>
          <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              <tr>
                <td align="center" style="padding:0px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 500px;">
                    
                    <!-- Dark Header with White Logo -->
                    <tr>
                      <td style="background-color: #111827; padding: 10px 20px;">
                        <img src="${logoUrl}" alt="ReCollect" height="70" style="display: block;" />
                      </td>
                    </tr>

                    <!-- White Content Area -->
                    <tr>
                      <td style="background-color: #ffffff; padding: 32px;">
                        <p style="margin: 0 0 8px; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">
                          Welcome
                        </p>
                        <h1 style="margin: 0 0 16px; font-size: 20px; font-weight: 600; color: #111827; line-height: 1.4;">
                          Welcome to ReCollect, ${user.name}!
                        </h1>
                        <p style="margin: 0 0 24px; font-size: 15px; color: #6b7280; line-height: 1.5;">
                          Your personal knowledge management system is ready. Start organizing your thoughts, notes, and ideas.
                        </p>
                        
                        <!-- Features List -->
                        <div style="margin: 0 0 24px; padding: 16px; background-color: #f9fafb; border-radius: 8px;">
                          <p style="margin: 0 0 12px; font-size: 14px; color: #111827; font-weight: 600;">What you can do:</p>
                          <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">✓ Create unlimited dashboards to organize your thoughts</p>
                          <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">✓ Add rich notes with text, links, and images</p>
                          <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">✓ Set reminders for important notes</p>
                          <p style="margin: 0 0 8px; font-size: 14px; color: #6b7280;">✓ Share your knowledge with secure links</p>
                          <p style="margin: 0; font-size: 14px; color: #6b7280;">✓ Search across all your content instantly</p>
                        </div>
                        
                        <a href="${frontendUrl}/dashboard" 
                           style="display: inline-block; background-color: #111827; color: #ffffff; text-decoration: none; padding: 12px 24px; font-size: 14px; font-weight: 500; border-radius: 6px;">
                          Get Started
                        </a>
                        
                        <!-- Tip Box -->
                        <div style="margin: 24px 0 0; padding: 16px; background-color: #eff6ff; border-radius: 8px;">
                          <p style="margin: 0 0 8px; font-size: 14px; color: #1e40af; font-weight: 600;">💡 Quick Tip</p>
                          <p style="margin: 0; font-size: 14px; color: #1e3a8a; line-height: 1.5;">
                            Start by creating your first dashboard and adding a few notes. The more you use ReCollect, the more valuable it becomes!
                          </p>
                        </div>
                      </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                      <td style="background-color: #ffffff; padding: 24px 32px; border-top: 1px solid #e5e5e5; border-radius: 0 0 8px 8px;">
                        <p style="margin: 0; font-size: 12px; color: #9ca3af; line-height: 1.5;">
                          ReCollect · <a href="${frontendUrl}/dashboard" style="color: #9ca3af; text-decoration: none;">Visit Dashboard</a>
                        </p>
                      </td>
                    </tr>

                  </table>
                </td>
              </tr>
            </table>
          </body>
        </html>
      `
    };

    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Failed to send welcome email:', error);
    return false;
  }
};

export const sendTodoReminderEmail = async (
  user: any,
  todo: any,
  reminder: any
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    // White text logo that works on dark backgrounds
    const logoUrl = 'https://res.cloudinary.com/dsfb3jjqx/image/upload/v1765101198/recollect/pyf5tmicuidnxtmi76e5.png';

    const mailOptions = {
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: user.email,
      subject: `Reminder: ${todo.text.substring(0, 50)}${todo.text.length > 50 ? '...' : ''}`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Task Reminder</title>
          </head>
          <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              <tr>
                <td align="center" style="padding:0px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 500px;">
                    
                    <!-- Dark Header with White Logo -->
                    <tr>
                      <td style="background-color: #111827; padding: 10px 20px;">
                        <img src="${logoUrl}" alt="ReCollect" height="70" style="display: block;" />
                      </td>
                    </tr>

                    <!-- White Content Area -->
                    <tr>
                      <td style="background-color: #ffffff; padding: 32px;">
                        <p style="margin: 0 0 8px; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">
                          Task Reminder
                        </p>
                        <h1 style="margin: 0 0 16px; font-size: 20px; font-weight: 600; color: #111827; line-height: 1.4;">
                          ${todo.text}
                        </h1>
                        <p style="margin: 0 0 24px; font-size: 15px; color: #6b7280; line-height: 1.5;">
                          Hi ${user.name}, this is a reminder for your scheduled task.
                        </p>
                        <a href="${frontendUrl}/dashboard?view=todos" 
                           style="display: inline-block; background-color: #111827; color: #ffffff; text-decoration: none; padding: 12px 24px; font-size: 14px; font-weight: 500; border-radius: 6px;">
                          View Task
                        </a>
                      </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                      <td style="background-color: #ffffff; padding: 24px 32px; border-top: 1px solid #e5e5e5; border-radius: 0 0 8px 8px;">
                        <p style="margin: 0; font-size: 12px; color: #9ca3af; line-height: 1.5;">
                          ReCollect · <a href="${frontendUrl}/dashboard" style="color: #9ca3af; text-decoration: none;">Manage notifications</a>
                        </p>
                      </td>
                    </tr>

                  </table>
                </td>
              </tr>
            </table>
          </body>
        </html>
      `
    };

    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error('Failed to send todo reminder email:', error);
    return false;
  }
};