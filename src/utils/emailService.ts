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

// ─── Minimalist Design System ────────────────────────────────────────
// Pure white background, left-aligned, high contrast, clean typography.

const LOGO_LIGHT_URL = 'https://res.cloudinary.com/dsfb3jjqx/image/upload/v1773391852/recollect-logo-1024px_3_yalexb.png'; 
const LOGO_DARK_URL = 'https://res.cloudinary.com/dsfb3jjqx/image/upload/v1773391852/recollect-logo-1024px_4_crmydu.png'; 

const BRAND_BLUE = '#2563eb';
const TEXT_BLACK = '#37352f';
const TEXT_GRAY = '#787774';
const BORDER_COLOR = '#e4e4e7';

// ─── Responsive Logo Block ───────────────────────────────────────────
const logoBlock = (size: number = 24): string => `
<img src="${LOGO_LIGHT_URL}" class="logo-light" alt="ReCollect" width="${size}" height="${size - 8} " style="display: block;" />
<!--[if !mso]><!--><img src="${LOGO_DARK_URL}" class="logo-dark" alt="ReCollect" width="${size}" height="${size - 8}" style="display: none;" /><!--<![endif]-->`;

// ─── Header Avatar Block ─────────────────────────────────────────────
const avatarBlock = (name: string, size: number = 24): string => {
  const initial = name ? name.charAt(0).toUpperCase() : 'R';
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width: ${size}px; height: ${size}px; background-color: #ededed; border-radius: 4px; border: 1px solid #e1e1e1;"><tr><td align="center" valign="middle" style="font-size: ${Math.floor(size * 0.6)}px; font-weight: 600; color: #37352f; line-height: 1; padding-bottom: 2px;">${initial}</td></tr></table>`;
};

// ─── Shared Email Wrapper ────────────────────────────────────────────
const wrapEmail = (content: string, frontendUrl: string, headerLabel?: string): string => `
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
                      ${avatarBlock(headerLabel || 'ReCollect', 24)}
                    </td>
                    <td valign="middle">
                      <span style="font-size: 16px; font-weight: 600; color: ${TEXT_GRAY}; letter-spacing: -0.01em;">${headerLabel || 'ReCollect'}</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Main Content -->
            <tr>
              <td align="left" style="padding-bottom: 24px;">
                ${content}
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="left" style="padding-top: 24px; border-top: 1px solid ${BORDER_COLOR};">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td valign="top" style="padding-right: 16px; padding-top: 0px; padding-left: 5px ">
                      ${logoBlock(40)}
                    </td>
                    <td valign="top">
                      <p style="margin: 0px;margin-top : -6px; font-size: 20px; font-weight: 600; color: ${TEXT_BLACK};">ReCollect</p>
                      <p style="margin: 0; font-size: 13px; color: #a1a1aa; line-height: 1.4;">
                        <a href="https://re-collect.in" style="color: #787774; border-bottom: 1px solid #d4d4d8;">Re-Collect.in</a>, the connected workspace<br />
                        for docs, projects, and Teams.
                      </p>
                      <div style="margin-top: 12px;">
                        <a href="https://re-collect.in/settings" style="color: #9ca3af; text-decoration: underline; font-size: 14px;">Update your email settings</a>
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
</html>`;

// ─── UI Components ───────────────────────────────────────────────────

const uiButton = (href: string, label: string): string => `
<a href="${href}" style="display: inline-block; background-color: ${BRAND_BLUE}; color: #ffffff; text-decoration: none; padding: 10px 18px; font-size: 14px; font-weight: 500; border-radius: 6px; line-height: 1;">
  ${label} &rarr;
</a>`;

const uiHeading = (text: string): string => `
<h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: ${TEXT_BLACK}; line-height: 1.2; letter-spacing: -0.02em;">${text}</h1>`;

const uiBody = (text: string): string => `
<p style="margin: 0 0 24px; font-size: 15px; color: ${TEXT_GRAY}; line-height: 1.6;">${text}</p>`;

// Action item block with light blue background and left border
const uiActionItem = (title: string, subtitle?: string): string => `
<div style="background-color: #f8fafc; border-left: 2px solid ${BRAND_BLUE}; padding: 12px 16px; margin: 24px 0;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0">
    <tr>
      <td valign="top" style="padding-right: 12px; padding-top: 3px;">
        <div style="width: 14px; height: 14px; border: 1.5px solid #cbd5e1; border-radius: 3px; background-color: #ffffff;"></div>
      </td>
      <td valign="top">
        <p style="margin: 0; font-size: 15px; color: ${BRAND_BLUE}; line-height: 1.4; font-weight: 500;">${title}</p>
        ${subtitle ? `<p style="margin: 4px 0 0; font-size: 13px; color: ${TEXT_GRAY};">${subtitle}</p>` : ''}
      </td>
    </tr>
  </table>
</div>`;

const uiQuote = (text: string, label: string = 'Description'): string => `
<div style="margin: 24px 0;">
  <p style="margin: 0 0 8px; font-size: 13px; font-weight: 600; color: ${TEXT_BLACK}; text-transform: uppercase; letter-spacing: 0.05em;">${label}</p>
  <div style="padding-left: 16px; border-left: 2px solid ${BORDER_COLOR};">
    <p style="margin: 0; font-size: 15px; color: ${TEXT_BLACK}; line-height: 1.6;">${text}</p>
  </div>
</div>`;


// ─── 1. Note Reminder ─────────────────────────────────────────────────
export const sendReminderEmail = async (
  user: any,
  content: any,
  reminder: any
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const descriptionBlock = content.description
      ? uiQuote(`${content.description.substring(0, 200)}${content.description.length > 200 ? '…' : ''}`)
      : '';

    const emailContent = `
      ${uiHeading(`Reminder: ${content.title}`)}
      ${uiBody(`Hi ${user.name}, ${reminder.message || 'here is your scheduled reminder.'}`)}
      
      <div style="margin: 0 0 8px;">
        ${uiButton(`${frontendUrl}/dashboard/${content.DashId}?note=${content._id}`, 'View in ReCollect')}
      </div>
      
      ${descriptionBlock}
    `;

    await transporter.sendMail({
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: user.email,
      subject: `Reminder: ${content.title}`,
      html: wrapEmail(emailContent, frontendUrl)
    });
    return true;
  } catch (error) {
    console.error('Failed to send reminder email:', error);
    return false;
  }
};

// ─── 2. Welcome ───────────────────────────────────────────────────────
export const sendWelcomeEmail = async (user: any): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const emailContent = `
      ${uiHeading('Welcome to ReCollect')}
      ${uiBody(`Hi ${user.name}, your workspace is ready. You can now start creating dashboards, capturing notes, and collaborating with your team.`)}
      
      <div style="margin: 0 0 32px;">
        ${uiButton(`${frontendUrl}/dashboard`, 'Open ReCollect')}
      </div>
      
      ${uiQuote('Create your first dashboard and add a few notes. Use tasks to track action items, and share documents when you need team input.', 'Getting started')}
    `;

    await transporter.sendMail({
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: user.email,
      subject: 'Welcome to ReCollect',
      html: wrapEmail(emailContent, frontendUrl)
    });
    return true;
  } catch (error) {
    console.error('Failed to send welcome email:', error);
    return false;
  }
};

// ─── 3. Task Reminder ─────────────────────────────────────────────────
export const sendTodoReminderEmail = async (
  user: any,
  todo: any,
  reminder: any,
  workspaceName?: string
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const headerLabel = workspaceName ? `${workspaceName} workspace` : 'ReCollect';

    const priorityStr = todo.priority ? `${(todo.priority as string).charAt(0).toUpperCase() + (todo.priority as string).slice(1)} priority` : '';

    const descriptionBlock = todo.description && todo.description.trim()
      ? uiQuote(todo.description.substring(0, 300))
      : '';

    const emailContent = `
      ${uiHeading('Task due reminder')}
      ${uiBody(`Hi ${user.name}, this is a reminder for your scheduled task.`)}
      
      ${uiActionItem(todo.title, priorityStr)}
      
      <div style="margin: 24px 0 8px;">
        ${uiButton(`${frontendUrl}/dashboard?view=todos`, 'View Task')}
      </div>

      ${descriptionBlock}
    `;

    await transporter.sendMail({
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: user.email,
      subject: `Task Due: ${todo.title.substring(0, 50)}${todo.title.length > 50 ? '…' : ''}`,
      html: wrapEmail(emailContent, frontendUrl, headerLabel)
    });
    return true;
  } catch (error) {
    console.error('Failed to send todo reminder email:', error);
    return false;
  }
};

// ─── 4. Access Request ────────────────────────────────────────────────
export const sendAccessRequestEmail = async (
  owner: { name: string; email: string },
  requester: { name: string; email: string },
  docTitle: string,
  docId: string,
  requestId: string
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const emailContent = `
      ${uiHeading(`${requester.name} requested access`)}
      ${uiBody(`<strong>${requester.email}</strong> requested access to <strong>${docTitle}</strong>. Open ReCollect to review their request.`)}
      
      <div style="margin: 0 0 8px;">
        ${uiButton(`${frontendUrl}/?view=docs&tab=requests`, 'Review request')}
      </div>
    `;

    await transporter.sendMail({
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: owner.email,
      subject: `${requester.name} requested access to "${docTitle}"`,
      html: wrapEmail(emailContent, frontendUrl)
    });
    return true;
  } catch (error) {
    console.error('Failed to send access request email:', error);
    return false;
  }
};

// ─── 5. Access Approved ───────────────────────────────────────────────
export const sendAccessApprovedEmail = async (
  requester: { name: string; email: string },
  ownerName: string,
  docTitle: string,
  docId: string
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const emailContent = `
      ${uiHeading(`You have access to ${docTitle}`)}
      ${uiBody(`<strong>${ownerName}</strong> has granted you access to this document. You can now view and edit its contents.`)}
      
      <div style="margin: 0 0 8px;">
        ${uiButton(`${frontendUrl}/?view=docs`, 'Open document')}
      </div>
    `;

    await transporter.sendMail({
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: requester.email,
      subject: `Access Granted: ${docTitle}`,
      html: wrapEmail(emailContent, frontendUrl)
    });
    return true;
  } catch (error) {
    console.error('Failed to send access approved email:', error);
    return false;
  }
};

// ─── 6. Task Assignment ──────────────────────────────────────────────
export const sendTaskAssignmentEmail = async (
  assignee: { name: string; email: string },
  assigner: { name: string; email: string },
  taskTitle: string,
  isGhostUser: boolean,
  workspaceName?: string
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const headerLabel = workspaceName ? `${workspaceName} workspace` : 'ReCollect';

    const subject = isGhostUser
      ? `${assigner.name} mentioned you in ReCollect`
      : `New task assigned in ReCollect`;

    const bodyText = isGhostUser
      ? `<strong>${assigner.name}</strong> assigned you a task. Create an account to fully view and manage your assigned action items.`
      : `<strong>${assigner.name}</strong> assigned you a task${workspaceName ? ` in the workspace.` : `.`}`;

    const ctaHref = isGhostUser ? `${frontendUrl}/register` : `${frontendUrl}/dashboard?view=todos`;
    const ctaLabel = isGhostUser ? 'Join workspace' : 'Open task';

    const emailContent = `
      ${uiHeading('New task assigned')}
      ${uiBody(bodyText)}
      
      <div style="margin-bottom: 24px;">
        <p style="margin: 0 0 8px; font-size: 14px; font-weight: 500; color: ${TEXT_BLACK};">Action Items</p>
        ${uiActionItem(taskTitle)}
      </div>
      
      ${uiButton(ctaHref, ctaLabel)}
    `;

    await transporter.sendMail({
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: assignee.email,
      subject,
      html: wrapEmail(emailContent, frontendUrl, headerLabel)
    });
    return true;
  } catch (error) {
    console.error('Failed to send task assignment email:', error);
    return false;
  }
};