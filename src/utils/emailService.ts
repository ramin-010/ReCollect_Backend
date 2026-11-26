// Email Service for Sending Reminders
// No database access: callers pass plain { name, email } objects (the unused Mongoose model type
// imports were removed in the Postgres port).
import { createMailTransport } from './mailTransport';

// Create reusable transporter (Gmail; EMAIL_DELIVERY=off drops every message: ./mailTransport)
const createTransporter = () => createMailTransport();

// ─── Minimalist Design System ────────────────────────────────────────
// Pure white background, left-aligned, high contrast, clean typography.

const LOGO_LIGHT_URL = 'https://kaaga.in/icons/icon-192.png'; 
const LOGO_DARK_URL = 'https://kaaga.in/icons/icon-192.png'; 

const BRAND_BLUE = '#2563eb';
const TEXT_BLACK = '#37352f';
const TEXT_GRAY = '#787774';
const BORDER_COLOR = '#e4e4e7';

// ─── Responsive Logo Block ───────────────────────────────────────────
const logoBlock = (size: number = 24): string => `
<img src="${LOGO_LIGHT_URL}" class="logo-light" alt="Kaaga" width="${size}" height="${size}" style="display: block;" />
<!--[if !mso]><!--><img src="${LOGO_DARK_URL}" class="logo-dark" alt="Kaaga" width="${size}" height="${size}" style="display: none;" /><!--<![endif]-->`;

// ─── Header Avatar Block ─────────────────────────────────────────────
const avatarBlock = (name: string, size: number = 24): string => {
  const initial = name ? name.charAt(0).toUpperCase() : 'K';
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
                      ${avatarBlock(headerLabel || 'Kaaga', 24)}
                    </td>
                    <td valign="middle">
                      <span style="font-size: 16px; font-weight: 600; color: ${TEXT_GRAY}; letter-spacing: -0.01em;">${headerLabel || 'Kaaga'}</span>
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
                      <p style="margin: 0px; font-size: 20px; font-weight: 600; color: ${TEXT_BLACK}; line-height: 0.8;">Kaaga</p>
                      <p style="margin: 0; font-size: 13px; color: #a1a1aa; line-height: 1.4;">
                        <a href="https://kaaga.in" style="color: #787774; border-bottom: 1px solid #d4d4d8;">kaaga.in</a>, one memory for all your AIs<br />
                        for docs, projects, and Teams.
                      </p>
                      <div style="margin-top: 12px;">
                        <a href="https://kaaga.in/settings" style="color: #9ca3af; text-decoration: underline; font-size: 14px;">Update your email settings</a>
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
        ${subtitle ? `<p style="margin: -6px 0 0; font-size: 13px; color: ${TEXT_GRAY};">${subtitle}</p>` : ''}
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


// ─── 1. Note Reminder: removed with the legacy Content feature (sendReminderEmail) ───

// ─── 2. Welcome ───────────────────────────────────────────────────────
export const sendWelcomeEmail = async (user: any): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const emailContent = `
      ${uiHeading('Welcome to Kaaga')}
      ${uiBody(`Hi ${user.name}, your workspace is ready. You can now start creating dashboards, capturing notes, and collaborating with your team.`)}
      
      <div style="margin: 0 0 32px;">
        ${uiButton(`${frontendUrl}/dashboard`, 'Open Kaaga')}
      </div>
      
      ${uiQuote('Create your first dashboard and add a few notes. Use tasks to track action items, and share documents when you need team input.', 'Getting started')}
    `;

    await transporter.sendMail({
      from: `"Kaaga" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: user.email,
      subject: 'Welcome to Kaaga',
      html: wrapEmail(emailContent, frontendUrl)
    });
    return true;
  } catch (error) {
    console.error('Failed to send welcome email:', error);
    return false;
  }
};

// ─── 3. Sharing (MANAGER_AND_DOCS_PLAN §2) ─────────────────────────────
// The task reminder emails moved to controllers/workspace/workspaceEmails.ts and
// controllers/personalTasks/personalEmails.ts. Callers skip undeliverable addresses (isDeliverableEmail).

const RECOLLECT_FROM = () => `"Kaaga" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`;

/** To the owner: someone reading his published doc asks to edit it; he answers in the Share menu. */
export const sendDocRequestEmail = async (
  owner: { name: string; email: string },
  requester: { name: string; email: string },
  docTitle: string,
  docId: string
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const emailContent = `
      ${uiHeading(`${escapeHtml(requester.name)} asks to edit ${escapeHtml(docTitle)}`)}
      ${uiBody(`<strong>${escapeHtml(requester.email)}</strong> read your published doc and asks to edit it. Say yes or no in the doc's Share menu.`)}
      <div style="margin: 0 0 8px;">
        ${uiButton(`${frontendUrl}/docs/${docId}?share=1`, 'Open the Share menu')}
      </div>
    `;
    await transporter.sendMail({
      from: RECOLLECT_FROM(),
      to: owner.email,
      subject: `${requester.name} asks to edit "${docTitle}"`,
      html: wrapEmail(emailContent, frontendUrl),
      text: `${requester.name} (${requester.email}) asks to edit "${docTitle}". Answer in the doc's Share menu: ${frontendUrl}/docs/${docId}?share=1`,
    });
    return true;
  } catch (error) {
    console.error('Failed to send the request email:', error);
    return false;
  }
};

/** To someone he added by email. */
export const sendDocSharedEmail = async (
  person: { name: string; email: string },
  ownerName: string,
  docTitle: string,
  docId: string,
  roleWords: string
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const emailContent = `
      ${uiHeading(`${escapeHtml(ownerName)} shared ${escapeHtml(docTitle)} with you`)}
      ${uiBody(`You ${escapeHtml(roleWords)}. It is in your Docs, under Shared.`)}
      <div style="margin: 0 0 8px;">
        ${uiButton(`${frontendUrl}/docs/${docId}`, 'Open the doc')}
      </div>
    `;
    await transporter.sendMail({
      from: RECOLLECT_FROM(),
      to: person.email,
      subject: `${ownerName} shared "${docTitle}" with you`,
      html: wrapEmail(emailContent, frontendUrl),
      text: `${ownerName} shared "${docTitle}" with you: you ${roleWords}. ${frontendUrl}/docs/${docId}`,
    });
    return true;
  } catch (error) {
    console.error('Failed to send the shared-doc email:', error);
    return false;
  }
};

/** To someone whose request to edit he said yes to. */
export const sendRequestApprovedEmail = async (
  requester: { name: string; email: string },
  ownerName: string,
  docTitle: string,
  docId: string
): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const emailContent = `
      ${uiHeading(`You can edit ${escapeHtml(docTitle)}`)}
      ${uiBody(`<strong>${escapeHtml(ownerName)}</strong> said yes. It is in your Docs, under Shared.`)}
      <div style="margin: 0 0 8px;">
        ${uiButton(`${frontendUrl}/docs/${docId}`, 'Open the doc')}
      </div>
    `;
    await transporter.sendMail({
      from: RECOLLECT_FROM(),
      to: requester.email,
      subject: `You can edit "${docTitle}"`,
      html: wrapEmail(emailContent, frontendUrl),
      text: `${ownerName} said yes: you can edit "${docTitle}". ${frontendUrl}/docs/${docId}`,
    });
    return true;
  } catch (error) {
    console.error('Failed to send the approval email:', error);
    return false;
  }
};

// NOTE: sendTaskAssignmentEmail has been moved to:
//   - controllers/workspace/workspaceEmails.ts (sendWorkspaceTaskAssignmentEmail + sendWorkspaceInviteEmail)

// ─── 6. Morning nudge (daily loop v2, LOOP_V2_SPEC §7) ──────────────────
// Sent by the nudge cron (src/services/learningDb/nudge.service.ts), which builds the content.
// Plain and calm: today's top items, active goals with days left, one button.

export interface MorningNudgeEmail {
  subject: string;
  heading: string;
  intro: string;
  /** The top planned items (at most 3). */
  items: Array<{ title: string; detail: string }>;
  /** Planned items beyond `items`. */
  moreCount: number;
  /** Active goals: "228 days left", "Due today", … */
  goals: Array<{ title: string; when: string }>;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const uiGoals = (goals: MorningNudgeEmail['goals']): string => `
<div style="margin: 24px 0;">
  <p style="margin: 0 0 8px; font-size: 13px; font-weight: 600; color: ${TEXT_BLACK}; text-transform: uppercase; letter-spacing: 0.05em;">Goals</p>
  <div style="padding-left: 16px; border-left: 2px solid ${BORDER_COLOR};">
    ${goals
      .map(
        (g) =>
          `<p style="margin: 0 0 6px; font-size: 15px; color: ${TEXT_BLACK}; line-height: 1.6;">${escapeHtml(g.title)} <span style="color: ${TEXT_GRAY};">&middot; ${escapeHtml(g.when)}</span></p>`
      )
      .join('')}
  </div>
</div>`;

/** The same digest as plain text (the multipart alternative). */
export function morningNudgeText(nudge: MorningNudgeEmail, appUrl: string): string {
  const lines = [nudge.heading, nudge.intro, ''];
  for (const item of nudge.items) lines.push(`- ${item.title} (${item.detail})`);
  if (nudge.moreCount > 0) lines.push(`+ ${nudge.moreCount} more in today's plan.`);
  if (nudge.goals.length > 0) {
    lines.push('', 'Goals');
    for (const g of nudge.goals) lines.push(`- ${g.title}: ${g.when}`);
  }
  lines.push('', `Open Kaaga: ${appUrl}`);
  return lines.join('\n');
}

export const sendMorningNudgeEmail = async (to: { name: string; email: string }, nudge: MorningNudgeEmail): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const emailContent = `
      ${uiHeading(escapeHtml(nudge.heading))}
      ${uiBody(escapeHtml(nudge.intro))}
      ${nudge.items.map((item) => uiActionItem(escapeHtml(item.title), escapeHtml(item.detail))).join('')}
      ${nudge.moreCount > 0 ? uiBody(`+ ${nudge.moreCount} more in today's plan.`) : ''}
      ${nudge.goals.length > 0 ? uiGoals(nudge.goals) : ''}
      <div style="margin: 24px 0 8px;">
        ${uiButton(frontendUrl, 'Open Kaaga')}
      </div>
    `;

    await transporter.sendMail({
      from: `"Kaaga" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to: to.email,
      subject: nudge.subject,
      html: wrapEmail(emailContent, frontendUrl),
      text: morningNudgeText(nudge, frontendUrl),
    });
    return true;
  } catch (error) {
    console.error('Failed to send morning nudge email:', error);
    return false;
  }
};

// ─── The database's awake time (hosting P1-15) ──────────────────────────────

export interface AwakeAlertEmail {
  alert: '60' | '80' | '90' | 'pace';
  month: string;
  hours: number;
  allowanceHours: number;
  percent: number;
  projectedHours: number;
}

/** The subject and plain text of an awake-time alert (to OWNER_EMAIL). */
export function awakeAlertText(info: AwakeAlertEmail): { subject: string; text: string } {
  const subject = info.alert === 'pace'
    ? `Kaaga's database: on pace for ${info.projectedHours} of ${info.allowanceHours} free hours this month`
    : `Kaaga's database: ${info.alert}% of this month's free hours used`;
  const text = [
    `${info.month}: the database has been awake about ${info.hours} h of the ${info.allowanceHours} h the free plan allows (${info.percent}%).`,
    `At this pace the month ends near ${info.projectedHours} h. When the hours run out, Neon suspends the database until next month.`,
    `Neon's console has the exact figure. To slow it down: a longer phone refresh or sweep, the paid plan for the rest of the month, or the database on the server.`,
  ].join('\n\n');
  return { subject, text };
}

export const sendAwakeAlertEmail = async (to: string, info: AwakeAlertEmail): Promise<boolean> => {
  try {
    const transporter = createTransporter();
    const { subject, text } = awakeAlertText(info);
    await transporter.sendMail({
      from: `"Kaaga" <${process.env.EMAIL_FROM || 'noreply@recollect.com'}>`,
      to,
      subject,
      text,
    });
    return true;
  } catch (error) {
    console.error('Failed to send the awake-time alert:', error instanceof Error ? error.message : String(error));
    return false;
  }
};
