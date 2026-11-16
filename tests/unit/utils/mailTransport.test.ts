// EMAIL_DELIVERY=off (src/utils/mailTransport.ts): a test backend on restored real data builds every
// message and drops it, and the send succeeds, so no job fails or retries; unset, Gmail as before.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMailTransport, emailDeliveryOff } from '../../../src/utils/mailTransport';

afterEach(() => {
    delete process.env.EMAIL_DELIVERY;
    vi.restoreAllMocks();
});

describe('the mail transport', () => {
    it('EMAIL_DELIVERY=off: built and dropped, the send succeeds, one line without the address or subject', async () => {
        process.env.EMAIL_DELIVERY = 'off';
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const transport = createMailTransport();
        expect(transport.transporter.name).toBe('JSONTransport');
        const info = await transport.sendMail({ from: 'a@example.org', to: 'b@example.org', subject: 'Reminder: a task', text: 'x' });
        // The JSON transport returns the built message (nodemailer's type for the send result omits it).
        expect(JSON.parse(String((info as unknown as { message: string }).message)).subject).toBe('Reminder: a task');
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('[mail] not delivered (EMAIL_DELIVERY=off)');
    });

    it('unset: Gmail over SMTP, as before', () => {
        expect(emailDeliveryOff({})).toBe(false);
        expect(emailDeliveryOff({ EMAIL_DELIVERY: 'OFF' })).toBe(true);
        expect(createMailTransport().transporter.name).toBe('SMTP');
    });
});
