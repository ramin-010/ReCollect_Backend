// Email Service for Sending Reminders
import nodemailer from 'nodemailer';
import { Reminder } from '../models/reminderSchema';
import { User } from '../models/userSchema';
import { Content } from '../models/contentSchema';

// Create reusable transporter
const createTransporter = () => {
  // For development, you can use Ethereal Email
  // For production, use real email service (Gmail, SendGrid, etc.)
  
  if (process.env.NODE_ENV === 'production') {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });
  } else {
    // Development - Use console logging
    return {
      sendMail: async (mailOptions: any) => {
        console.log('📧 Email would be sent:', mailOptions);
        return { messageId: 'test-message-id' };
      }
    };
  }
};

export const sendReminderEmail = async (
  user: any,
  content: any,
  reminder: any
): Promise<boolean> => {
  try {
    const transporter = createTransporter();

    const mailOptions = {
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: user.email,
      subject: `📌 Reminder: ${content.title}`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <title>ReCollect Reminder</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                line-height: 1.6;
                color: #333;
                max-width: 600px;
                margin: 0 auto;
                padding: 20px;
              }
              .header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 30px;
                border-radius: 10px 10px 0 0;
                text-align: center;
              }
              .logo {
                font-size: 32px;
                font-weight: bold;
                margin-bottom: 10px;
              }
              .content {
                background: white;
                padding: 30px;
                border: 1px solid #e2e8f0;
                border-radius: 0 0 10px 10px;
              }
              .note-title {
                font-size: 24px;
                font-weight: bold;
                color: #2d3748;
                margin-bottom: 15px;
              }
              .note-body {
                background: #f7fafc;
                padding: 20px;
                border-radius: 8px;
                margin: 20px 0;
                color: #4a5568;
              }
              .button {
                display: inline-block;
                background: #667eea;
                color: white;
                padding: 12px 30px;
                text-decoration: none;
                border-radius: 6px;
                font-weight: 500;
                margin-top: 20px;
              }
              .footer {
                text-align: center;
                margin-top: 30px;
                padding-top: 20px;
                border-top: 1px solid #e2e8f0;
                color: #718096;
                font-size: 14px;
              }
              .reminder-info {
                background: #fef5e7;
                border-left: 4px solid #f39c12;
                padding: 15px;
                margin: 20px 0;
              }
            </style>
          </head>
          <body>
            <div class="header">
              <div class="logo">ReCollect</div>
              <p>Your Knowledge Reminder</p>
            </div>
            
            <div class="content">
              <p>Hi ${user.name},</p>
              
              <div class="reminder-info">
                <strong>⏰ This is your scheduled reminder!</strong><br>
                ${reminder.message || 'You asked to be reminded about this note.'}
              </div>
              
              <div class="note-title">
                📝 ${content.title}
              </div>
              
              ${content.body ? `
                <div class="note-body">
                  ${content.body.substring(0, 500)}${content.body.length > 500 ? '...' : ''}
                </div>
              ` : ''}
              
              <a href="${process.env.FRONTEND_URL}/dashboard/${content.DashId}?note=${content._id}" class="button">
                View Full Note →
              </a>
              
              <div class="footer">
                <p>
                  This reminder was set by you on ${new Date(reminder.createdAt).toLocaleDateString()}.
                  <br>
                  To manage your reminders, visit your ReCollect dashboard.
                </p>
                <p>
                  © ${new Date().getFullYear()} ReCollect. All rights reserved.
                </p>
              </div>
            </div>
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

    const mailOptions = {
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: user.email,
      subject: 'Welcome to ReCollect! 🎉',
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <title>Welcome to ReCollect</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                line-height: 1.6;
                color: #333;
                max-width: 600px;
                margin: 0 auto;
                padding: 20px;
              }
              .header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 40px;
                border-radius: 10px;
                text-align: center;
                margin-bottom: 30px;
              }
              .logo {
                font-size: 36px;
                font-weight: bold;
                margin-bottom: 10px;
              }
              .content {
                background: white;
                padding: 30px;
              }
              .features {
                background: #f7fafc;
                padding: 20px;
                border-radius: 8px;
                margin: 20px 0;
              }
              .feature-item {
                margin: 10px 0;
                padding-left: 25px;
                position: relative;
              }
              .feature-item::before {
                content: "✓";
                position: absolute;
                left: 0;
                color: #48bb78;
                font-weight: bold;
              }
              .button {
                display: inline-block;
                background: #667eea;
                color: white;
                padding: 14px 35px;
                text-decoration: none;
                border-radius: 6px;
                font-weight: 500;
                margin: 20px 0;
              }
              .footer {
                text-align: center;
                margin-top: 30px;
                padding-top: 20px;
                border-top: 1px solid #e2e8f0;
                color: #718096;
                font-size: 14px;
              }
            </style>
          </head>
          <body>
            <div class="header">
              <div class="logo">ReCollect</div>
              <p>Your Professional Knowledge Management System</p>
            </div>
            
            <div class="content">
              <h2>Welcome aboard, ${user.name}! 🚀</h2>
              
              <p>
                We're thrilled to have you join the ReCollect community. 
                You've just taken the first step towards building your second brain!
              </p>
              
              <div class="features">
                <h3>Here's what you can do with ReCollect:</h3>
                <div class="feature-item">Create unlimited dashboards to organize your thoughts</div>
                <div class="feature-item">Add rich notes with text, links, and images</div>
                <div class="feature-item">Set reminders for important notes</div>
                <div class="feature-item">Share your knowledge with secure links</div>
                <div class="feature-item">Search across all your content instantly</div>
              </div>
              
              <center>
                <a href="${process.env.FRONTEND_URL}/dashboard" class="button">
                  Start Exploring →
                </a>
              </center>
              
              <p>
                <strong>Quick tip:</strong> Start by creating your first dashboard 
                and adding a few notes. The more you use ReCollect, the more valuable 
                it becomes!
              </p>
              
              <div class="footer">
                <p>
                  Need help? Reply to this email or visit our 
                  <a href="${process.env.FRONTEND_URL}/help">help center</a>.
                </p>
                <p>
                  © ${new Date().getFullYear()} ReCollect. All rights reserved.
                </p>
              </div>
            </div>
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
