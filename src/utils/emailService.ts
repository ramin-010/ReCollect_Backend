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

// ─── Shared Design System (Notion EXACT Match) ───────────────────────
// Clean white background, fully left-aligned, bold black headings, blue CTA.

const LOGO_URL = 'https://res.cloudinary.com/dsfb3jjqx/image/upload/v1765101198/recollect/pyf5tmicuidnxtmi76e5.png'; // Black recoloc logo
const NOTION_BLUE = '#2383e2';
const TEXT_BLACK = '#0f0f0f';
const TEXT_GRAY = '#6b7280';
const BORDER_COLOR = '#ebebeb';

const wrapEmail = (content: string, frontendUrl: string): string => `
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
          <!-- Wrap content and force left alignment. Max-width 600px like Notion. -->
          <table role="presentation" cellspacing="0" cellpadding="0" style="max-width: 600px; width: 100%; border: none;">
            
            <!-- Header Logo Row -->
            <tr>
              <td style="padding-bottom: 24px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding-right: 8px;">
                      <img src="${LOGO_URL}" alt="ReCollect Logo" width="20" height="20" style="display: block; border-radius: 4px;" />
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
                ${content}
              </td>
            </tr>

            <!-- Notion Style Footer -->
            <tr>
              <td align="left" style="padding-top: 24px; border-top: 1px solid ${BORDER_COLOR};">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td style="padding-bottom: 12px;">
                      <img src="${LOGO_URL}" alt="ReCollect Logo" width="24" height="24" style="display: block; border-radius: 4px;" />
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <p style="margin: 0 0 4px; font-size: 12px; color: #a3a3a3; font-weight: 500;">ReCollect</p>
                      <p style="margin: 0; font-size: 11px; color: #a3a3a3; line-height: 1.5;">
                        Your connected workspace for docs, projects, and wikis.<br />
                        <a href="${frontendUrl}/dashboard" style="color: #a3a3a3; text-decoration: underline;">Manage notifications</a>
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
</html>`;

// Reusable UI elements matching Notion's exact visual spec
const uiButton = (href: string, label: string): string => `
<a href="${href}" style="display: inline-block; background-color: ${NOTION_BLUE}; color: #ffffff; text-decoration: none; padding: 8px 16px; font-size: 14px; font-weight: 500; border-radius: 4px; line-height: 1.2;">
  ${label} &rarr;
</a>`;

// Flat minimal bounding box with faint blue background like Notion edits
const uiCard = (text: string): string => `
<div style="margin: 20px 0; padding: 12px 16px; background-color: #f7fbff; border-left: 3px solid ${NOTION_BLUE};">
  <p style="margin: 0; font-size: 14px; color: ${TEXT_BLACK}; line-height: 1.4;">${text}</p>
</div>`;

const uiHeading = (text: string): string => `
<h1 style="margin: 0 0 16px; font-size: 24px; font-weight: 700; color: ${TEXT_BLACK}; line-height: 1.25; letter-spacing: -0.02em;">${text}</h1>`;

const uiBody = (text: string): string => `
<p style="margin: 0 0 20px; font-size: 15px; color: ${TEXT_GRAY}; line-height: 1.6;">${text}</p>`;


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
      ? `<div style="margin: 16px 0; padding: 12px 0;">
           <p style="margin: 0; font-size: 14px; color: ${TEXT_BLACK}; line-height: 1.5; padding-left: 12px; border-left: 2px solid ${BORDER_COLOR};">${content.description.substring(0, 200)}${content.description.length > 200 ? '...' : ''}</p>
         </div>`
      : '';

    const emailContent = `
      ${uiHeading(`Reminder: ${content.title}`)}
      ${uiBody(`Hi ${user.name}, ${reminder.message || 'here is your scheduled reminder.'}`)}
      ${uiButton(`${frontendUrl}/dashboard/${content.DashId}?note=${content._id}`, 'View in ReCollect')}
      
      ${descriptionBlock ? `<div style="margin-top: 32px;">
        <p style="margin: 0 0 8px; font-size: 13px; font-weight: 500; color: ${TEXT_BLACK};">@${new Date().toLocaleDateString()}</p>
        ${descriptionBlock}
      </div>` : ''}
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
      ${uiBody(`Hi ${user.name},<br><br>Your personal workspace is ready. You can now start creating dashboards, capturing notes, setting task reminders, and collaborating with your team.`)}
      
      <div style="margin: 0 0 24px;">
        ${uiButton(`${frontendUrl}/dashboard`, 'Open application')}
      </div>
      
      <div style="margin-top: 32px;">
        <p style="margin: 0 0 12px; font-size: 13px; font-weight: 500; color: ${TEXT_BLACK};">Getting started quickly</p>
        <p style="margin: 0 0 16px; font-size: 14px; color: ${TEXT_GRAY}; line-height: 1.5;">The best way to get started is to create your first dashboard and add a few notes. Use tasks to track action items, and share documents when you need team input.</p>
      </div>
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
  reminder: any
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const priorityBlock = todo.priority 
      ? `<span style="color: ${TEXT_GRAY}; margin-left: 8px;">· ${(todo.priority as string).charAt(0).toUpperCase() + (todo.priority as string).slice(1)} priority</span>` 
      : '';

    let descriptionBlock = '';
    if (todo.description && todo.description.trim()) {
      descriptionBlock = `
        <div style="margin-top: 24px; padding-top: 24px; border-top: 1px solid ${BORDER_COLOR};">
          <p style="margin: 0 0 8px; font-size: 13px; font-weight: 500; color: ${TEXT_BLACK};">Description</p>
          <div style="padding-left: 12px; border-left: 2px solid ${BORDER_COLOR};">
            <p style="margin: 0; font-size: 14px; color: ${TEXT_BLACK}; line-height: 1.5;">${todo.description.substring(0, 300)}</p>
          </div>
        </div>`;
    }

    const emailContent = `
      ${uiHeading(todo.title)}
      <p style="margin: 0 0 24px; font-size: 13px;">
        <span style="font-weight: 500; color: ${TEXT_BLACK};">Task Due</span>
        ${priorityBlock}
      </p>
      
      ${uiBody(`Hi ${user.name}, this is a reminder for your scheduled task.`)}
      
      <div style="margin: 20px 0;">
        ${uiButton(`${frontendUrl}/dashboard?view=todos`, 'View Task')}
      </div>

      ${descriptionBlock}
    `;

    await transporter.sendMail({
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: user.email,
      subject: `Task Due: ${todo.title.substring(0, 50)}${todo.title.length > 50 ? '...' : ''}`,
      html: wrapEmail(emailContent, frontendUrl)
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
      ${uiBody(`${requester.email} requested access to the document <strong>${docTitle}</strong>. Open ReCollect to review their request.`)}
      
      <div style="margin: 24px 0 0;">
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
      
      <div style="margin: 24px 0 0;">
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
  isGhostUser: boolean
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const subject = isGhostUser
      ? `${assigner.name} mentioned you in ReCollect`
      : `New task assigned in ReCollect`;

    const bodyText = isGhostUser
      ? `<strong>${assigner.name}</strong> assigned you a task. Create an account to view and manage your assigned action items.`
      : `<strong>${assigner.name}</strong> assigned you a task in the workspace.`;

    const ctaHref = isGhostUser ? `${frontendUrl}/register` : `${frontendUrl}/dashboard?view=todos`;
    const ctaLabel = isGhostUser ? 'Join workspace' : 'Open task';

    const emailContent = `
      ${uiHeading('New task assigned')}
      ${uiBody(bodyText)}
      
      <!-- Styled exactly like the Notion "Action Items" block screenshot -->
      <div style="margin: 24px 0 32px;">
        <p style="margin: 0 0 12px; font-size: 13px; font-weight: 500; color: ${TEXT_BLACK};">Action Items</p>
        <div style="background-color: #f7fbff; border-left: 2px solid ${NOTION_BLUE}; padding: 12px 16px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td valign="top" style="padding-right: 8px; padding-top: 1px;">
                <div style="width: 14px; height: 14px; border: 1px solid #c9c9c9; border-radius: 3px; background-color: #ffffff;"></div>
              </td>
              <td valign="top">
                <p style="margin: 0; font-size: 14px; color: ${NOTION_BLUE}; line-height: 1.4;">${taskTitle}</p>
              </td>
            </tr>
          </table>
        </div>
      </div>
      
      ${uiButton(ctaHref, ctaLabel)}
    `;

    await transporter.sendMail({
      from: `"ReCollect" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: assignee.email,
      subject,
      html: wrapEmail(emailContent, frontendUrl)
    });
    return true;
  } catch (error) {
    console.error('Failed to send task assignment email:', error);
    return false;
  }
};