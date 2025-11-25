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

    const mailOptions = {
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: user.email,
      subject: `📌 Reminder: ${content.title}`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>ReCollect Reminder</title>
            <!-- Import Inter font for a more premium look where supported -->
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
                background-color: #f3f4f6; /* Softer, cooler gray */
                color: #1f2937; /* Dark gray for better readability than pure black */
                line-height: 1.6;
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
              }

              /* Layout */
               .email-wrapper {
            background-color: #f3f4f6;
             padding: 8px 10px; 
            min-height: 100vh;
        }

        .email-container {
            max-width: 600px;
            /* Slightly narrower for better reading measure */
            margin: 0 auto;
            background: #ffffff;
            border-radius: 16px;
            /* More rounded corners */
            overflow: hidden;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04);
        }

              /* Header */
              .header {
                background: #ffffff;
                padding: 25px 40px 14px;
                text-align: center;
              }
              .logo-img {
                height: 68px; /* Refined size */
                width: auto;
                display: block;
                margin: 0 auto;
              }

              /* Content */
              .content {
                padding: 0 48px 48px;
              }
              .greeting {
                font-size: 18px;
                color: #111827;
                margin-bottom: 32px;
                font-weight: 500;
                text-align: center;
              }

              /* Cards */
              .card {
                background: #ffffff;
                border: 1px solid #e5e7eb;
                border-radius: 12px;
                padding: 24px;
                margin-bottom: 24px;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
              }
              .card-highlight {
                background: #f9fafb; /* Very subtle contrast */
                border-color: #e5e7eb;
              }

              /* Reminder Section */
              .reminder-header {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 12px;
              }
              .reminder-badge {
                background: #fee2e2;
                color: #991b1b;
                font-size: 11px;
                font-weight: 700;
                padding: 4px 8px;
                border-radius: 20px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                display: inline-flex;
                align-items: center;
                gap: 4px;
              }
              .reminder-message {
                font-size: 15px;
                color: #4b5563;
                line-height: 1.6;
              }

              /* Note Section */
              .note-label {
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 1px;
                color: #6b7280;
                font-weight: 600;
                margin-bottom: 8px;
                display: block;
              }
              .note-title {
                font-size: 20px;
                font-weight: 700;
                color: #111827;
                line-height: 1.3;
                margin-bottom: 4px;
              }
              .note-preview {
                font-size: 14px;
                color: #6b7280;
                margin-top: 8px;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
                overflow: hidden;
              }

              /* CTA */
              .cta-container {
                text-align: center;
                margin-top: 40px;
                margin-bottom: 16px;
              }
              .cta-button {
                display: inline-block;
                background: #000000;
                color: #ffffff;
                padding: 16px 40px;
                text-decoration: none;
                border-radius: 100px; /* Pill shape */
                font-weight: 600;
                font-size: 15px;
                transition: all 0.2s ease;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
              }
              .cta-button:hover {
                background: #1f2937;
                transform: translateY(-1px);
                box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
              }

              /* Footer */
              .footer {
                padding: 32px;
                background: #f9fafb;
                border-top: 1px solid #f3f4f6;
                text-align: center;
              }
              .footer-text {
                color: #9ca3af;
                font-size: 12px;
                line-height: 1.6;
                margin: 4px 0;
              }
              .footer-link {
                color: #6b7280;
                text-decoration: none;
                font-weight: 500;
                transition: color 0.2s;
              }
              .footer-link:hover {
                color: #111827;
                text-decoration: underline;
              }
              .divider {
                height: 1px;
                background: #e5e7eb;
                width: 40px;
                margin: 24px auto;
              }

              /* Mobile */
              @media only screen and (max-width: 600px) {
                .email-wrapper {
                  padding: 12px;
                }
                .content {
                  padding: 0 24px 32px;
                }
                .header {
                  padding: 32px 24px 24px;
                }
                .cta-button {
                  width: 100%;
                  text-align: center;
                }
              }
            </style>
          </head>
          <body>
            <div class="email-wrapper">
              <div class="email-container">
                <div class="header">
                  <img src="https://res.cloudinary.com/dsfb3jjqx/image/upload/v1763902793/recollect/yg9aexn9iwtxmun5du4d.png" alt="ReCollect" class="logo-img" style="background-color:white ; border-radius: 4px; />
                </div>
                
                <div class="content">
                  <div class="greeting">
                    Hi ${user.name}, here's your reminder.
                  </div>
                  
                  <!-- Reminder Card -->
                  <div class="card card-highlight">
                    <div class="reminder-header">
                      <span class="reminder-badge">🔔 Reminder</span>
                    </div>
                    <div class="reminder-message">
                      ${reminder.message || 'You asked to be reminded about this note.'}
                    </div>
                  </div>
                  
                  <!-- Note Content Card -->
                  <div class="card">
                    <span class="note-label">From your note</span>
                    <h2 class="note-title">${content.title}</h2>
                    <p class="note-preview">
                      ${content.description || 'No preview available.'}
                    </p>
                  </div>
                  
                  <div class="cta-container">
                    <a href="${process.env.FRONTEND_URL}/dashboard/${content.DashId}?note=${content._id}" class="cta-button">
                      View Note in ReCollect
                    </a>
                  </div>
                </div>
                
                <div class="footer">
                  <p class="footer-text">
                    Sent via ReCollect • Your Personal Knowledge Base
                  </p>
                  <div class="divider"></div>
                  <p class="footer-text">
                    <a href="${process.env.FRONTEND_URL}/dashboard" class="footer-link">Manage Reminders</a> • <a href="${process.env.FRONTEND_URL}/dashboard" class="footer-link">Unsubscribe</a>
                  </p>
                  <p class="footer-text" style="margin-top: 16px;">
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
      subject: 'Welcome to ReCollect',
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Welcome to ReCollect</title>
            <!-- Import Inter font for a more premium look where supported -->
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
                background-color: #f3f4f6; /* Softer, cooler gray */
                color: #1f2937; /* Dark gray for better readability than pure black */
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
                max-width: 560px; /* Slightly narrower for better reading measure */
                margin: 0 auto;
                background: #ffffff;
                border-radius: 16px; /* More rounded corners */
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
                height: 68px; /* Refined size */
                width: auto;
                display: block;
                margin: 0 auto 20px;
              }
              .header-title {
                font-size: 24px;
                font-weight: 700;
                color: #111827;
                margin-bottom: 8px;
                line-height: 1.3;
                letter-spacing: -0.02em;
              }
              .header-subtitle {
                font-size: 16px;
                color: #6b7280;
                font-weight: 400;
                line-height: 1.5;
              }

              /* Content */
              .content {
                padding: 0 48px 48px;
              }
              .greeting {
                font-size: 18px;
                color: #111827;
                margin-bottom: 32px;
                font-weight: 500;
                text-align: center;
              }

              /* Cards */
              .card {
                background: #ffffff;
                border: 1px solid #e5e7eb;
                border-radius: 12px;
                padding: 24px;
                margin-bottom: 24px;
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
              }
              
              /* Features Section */
              .features-title {
                font-size: 14px;
                font-weight: 600;
                color: #111827;
                margin-bottom: 16px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
              }
              .feature-item {
                display: flex;
                align-items: flex-start;
                margin-bottom: 16px;
                gap: 12px;
              }
              .feature-item:last-child {
                margin-bottom: 0;
              }
              .feature-icon {
                color: #10b981; /* Premium green */
                font-size: 18px;
                margin-top: 2px;
                flex-shrink: 0;
                background: #ecfdf5;
                width: 24px;
                height: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                font-size: 14px;
              }
              .feature-text {
                font-size: 15px;
                color: #4b5563;
                line-height: 1.5;
              }

              /* Tip Box */
              .tip-box {
                background: #eff6ff;
                border: 1px solid #dbeafe;
                border-radius: 12px;
                padding: 20px;
                margin-top: 32px;
              }
              .tip-title {
                font-size: 14px;
                font-weight: 600;
                color: #1e40af;
                margin-bottom: 8px;
                display: flex;
                align-items: center;
                gap: 6px;
              }
              .tip-text {
                font-size: 14px;
                color: #1e3a8a;
                line-height: 1.6;
              }

              /* CTA */
              .cta-container {
                text-align: center;
                margin-top: 40px;
                margin-bottom: 16px;
              }
              .cta-button {
                display: inline-block;
                background: #000000;
                color: #ffffff;
                padding: 16px 40px;
                text-decoration: none;
                border-radius: 100px; /* Pill shape */
                font-weight: 600;
                font-size: 15px;
                transition: all 0.2s ease;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
              }
              .cta-button:hover {
                background: #1f2937;
                transform: translateY(-1px);
                box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
              }

              /* Footer */
              .footer {
                padding: 32px;
                background: #f9fafb;
                border-top: 1px solid #f3f4f6;
                text-align: center;
              }
              .footer-text {
                color: #9ca3af;
                font-size: 12px;
                line-height: 1.6;
                margin: 4px 0;
              }
              .footer-link {
                color: #6b7280;
                text-decoration: none;
                font-weight: 500;
                transition: color 0.2s;
              }
              .footer-link:hover {
                color: #111827;
                text-decoration: underline;
              }
              .divider {
                height: 1px;
                background: #e5e7eb;
                width: 40px;
                margin: 24px auto;
              }

              /* Mobile */
              @media only screen and (max-width: 600px) {
                .email-wrapper {
                  padding: 12px;
                }
                .content {
                  padding: 0 24px 32px;
                }
                .header {
                  padding: 32px 24px 24px;
                }
                .header-title {
                  font-size: 22px;
                }
                .cta-button {
                  width: 100%;
                  text-align: center;
                }
              }
            </style>
          </head>
          <body>
            <div class="email-wrapper">
              <div class="email-container">
                <div class="header">
                  <img src="https://res.cloudinary.com/dsfb3jjqx/image/upload/v1763902793/recollect/yg9aexn9iwtxmun5du4d.png" alt="ReCollect" class="logo-img" style="background-color:white ; border-radius: 4px; />
                  <h1 class="header-title">Welcome to ReCollect</h1>
                  <p class="header-subtitle">Your personal knowledge management system</p>
                </div>
                
                <div class="content">
                  <div class="greeting">
                    Hi ${user.name}, welcome aboard!
                  </div>
                   
                  <div class="card">
                    <h2 class="features-title">What you can do</h2>
                    <div class="feature-item">
                      <span class="feature-icon">✓</span>
                      <span class="feature-text">Create unlimited dashboards to organize your thoughts</span>
                    </div>
                    <div class="feature-item">
                      <span class="feature-icon">✓</span>
                      <span class="feature-text">Add rich notes with text, links, and images</span>
                    </div>
                    <div class="feature-item">
                      <span class="feature-icon">✓</span>
                      <span class="feature-text">Set reminders for important notes</span>
                    </div>
                    <div class="feature-item">
                      <span class="feature-icon">✓</span>
                      <span class="feature-text">Share your knowledge with secure links</span>
                    </div>
                    <div class="feature-item">
                      <span class="feature-icon">✓</span>
                      <span class="feature-text">Search across all your content instantly</span>
                    </div>
                  </div>
                  
                  <div class="cta-container">
                    <a href="${process.env.FRONTEND_URL}/dashboard" class="cta-button">
                      Get Started
                    </a>
                  </div>
                  
                  <div class="tip-box">
                    <div class="tip-title">💡 Quick Tip</div>
                    <div class="tip-text">
                      Start by creating your first dashboard and adding a few notes. The more you use ReCollect, the more valuable it becomes!
                    </div>
                  </div>
                </div>
                
                <div class="footer">
                  <p class="footer-text">
                    Sent via ReCollect • Your Personal Knowledge Base
                  </p>
                  <div class="divider"></div>
                  <p class="footer-text">
                    Need help? <a href="${process.env.FRONTEND_URL}/help" class="footer-link">Visit our help center</a> or reply to this email.
                  </p>
                  <p class="footer-text" style="margin-top: 16px;">
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
    console.error('Failed to send welcome email:', error);
    return false;
  }
};