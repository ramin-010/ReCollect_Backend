// The one way the app makes a mail transport (codes, reminders, the morning email, workspace and task
// emails). Unset: Gmail with EMAIL_USER / EMAIL_PASSWORD, as before.
//
// EMAIL_DELIVERY=off (a test backend on restored real data, hosting phase 2): nothing leaves the server.
// Each message is built and dropped by nodemailer's JSON transport, and the send reports success, so
// every job finishes as it would in production (a reminder is marked sent, the morning email's day is
// done) and nothing is retried. Never set in production.
import nodemailer from 'nodemailer';

export const emailDeliveryOff = (env: NodeJS.ProcessEnv = process.env): boolean => /^(off|0|false|no)$/i.test(env['EMAIL_DELIVERY'] ?? '');

export function createMailTransport() {
    if (emailDeliveryOff()) {
        const transport = nodemailer.createTransport({ jsonTransport: true });
        // One line per message, never its address or subject (the data may be real).
        transport.use('compile', (_mail, done) => {
            console.log('[mail] not delivered (EMAIL_DELIVERY=off)');
            done();
        });
        return transport;
    }
    return nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
    });
}
