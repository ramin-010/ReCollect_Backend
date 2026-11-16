// Outgoing email in tests: tests/integration/setup.ts mocks `nodemailer` with createNodemailerMock(),
// so every transporter.sendMail() is recorded here instead of being sent.
export interface SentMail {
    from?: string;
    to?: string;
    subject?: string;
    html?: string;
    text?: string;
}

// Kept on globalThis so the mocked module and the test file always share one mailbox.
const box = globalThis as unknown as { __testMailbox?: SentMail[]; __testMailFails?: boolean };
box.__testMailbox ??= [];
box.__testMailFails ??= false;

export function sentMails(): SentMail[] {
    return box.__testMailbox ?? [];
}

export function clearSentMails(): void {
    box.__testMailbox = [];
    box.__testMailFails = false;
}

/** Make the next sendMail() calls reject (to test "Failed to send OTP email"). */
export function setMailFailure(fail: boolean): void {
    box.__testMailFails = fail;
}

export function mailsTo(email: string): SentMail[] {
    return sentMails().filter((m) => String(m.to).toLowerCase() === email.toLowerCase());
}

/** The code (6 digits since the hosting review; 4 before) of the last OTP email sent to `email` (subject is "Login Code: 1234"). */
export function lastOtpSentTo(email: string): string | undefined {
    const mails = mailsTo(email);
    const last = mails[mails.length - 1];
    return last?.subject?.match(/(\d{4,8})/)?.[1];
}

export function createNodemailerMock() {
    const createTransport = () => ({
        sendMail: async (options: SentMail) => {
            if (box.__testMailFails) throw new Error('SMTP unavailable (test)');
            (box.__testMailbox ??= []).push(options);
            return { messageId: `test-${Date.now()}`, accepted: [options.to] };
        },
        verify: async () => true,
    });
    return { default: { createTransport }, createTransport };
}
