// Meera's three days (SIMULATION_PLAN §5.5): is the buddy made for anyone? An invented ICU nurse in Pune on night
// shifts (she sleeps 09:00 to 16:00), she/her, no Claude Code: the chat, Tell, her phone and an old claude.ai
// export. Checked: never "he" or "his" about her; nothing that assumes an engineer, an office or a 9-to-5; her
// questions in her waking hours; a plan for March silent now; her health worry never on a screen.
import type { Ev, Msg, Person } from './types';

const keep = (text: string, becomes: Msg['becomes'], extra: Partial<Msg> = {}): Msg => ({ text, becomes, ...extra });

const truth: Record<string, string> = {
    '2026-11-22': 'Sunday, off. Set up Recollect. Did Spanish for 10 minutes.',
    '2026-11-23': 'Night shift 19:00 to 07:30 (Mon night). Did Spanish for 10 minutes before the shift. Slept 09:00 to 16:00.',
    '2026-11-24': 'Night shift again. Back pain bad after lifting a patient, thinking of an MRI. No Spanish.',
    '2026-11-25': 'Last night shift of the week. Did Spanish on the break. Her daughter Anika\'s school play is Friday 27 Nov at 17:00; she will go.',
    '2026-11-26': 'Off. Slept in. Booked a physiotherapy appointment for Saturday.',
};

const events: Ev[] = [
    { at: '11-23 08:10', kind: 'chat', via: 'tell', messages: [keep("just finished a 12 hour night shift. i want to keep up spanish, 10 minutes a day, even on shift days. did today's before work", ['new:S1', 'update:S1'])], persona: 1 },
    { at: '11-23 08:30', kind: 'phone', answer: true },
    { at: '11-23 16:30', kind: 'phone', answer: true },
    { at: '11-23 17:00', kind: 'chat', via: 'ask', messages: [keep('my ccrn certification exam is in march. i will start proper prep in january, not before', 'new:S2')] },
    { at: '11-23 18:15', kind: 'chat', via: 'ask', messages: [keep('remind me at 6:40 to take my lunch box', 'reminder:silent')], expect: [{ tools: ['set_reminder'], ring: false }] },
    { at: '11-24 02:30', kind: 'phoneTell', msg: keep('on break. back is killing me after lifting a patient. might need an mri', 'new:S4', { private: true }) },
    { at: '11-24 08:15', kind: 'phone', answer: true },
    { at: '11-24 16:40', kind: 'chat', via: 'ask', messages: [keep('no spanish yesterday, too tired after the shift. please don\'t remind me about spanish on weekends by the way', ['update:S1', 'memory', 'nosteer:S1'])], persona: 1 },
    { at: '11-24 17:00', kind: 'import', file: 'claude', limitUsd: 0.5 },
    { at: '11-25 03:00', kind: 'phoneTell', msg: keep('did my spanish on the break today!', 'update:S1') },
    { at: '11-25 08:20', kind: 'phone', answer: true },
    { at: '11-25 16:30', kind: 'chat', via: 'ask', messages: [keep("anika's school play is friday at 5pm. i'll go straight after waking up", 'new:S3')] },
    { at: '11-25 17:00', kind: 'phone', answer: true },
    { at: '11-26 11:00', kind: 'chat', via: 'ask', messages: [keep('day off finally. booked physio for saturday for my back', ['update:S4'], { private: true })], persona: 1 },
    { at: '11-26 13:00', kind: 'phone', answer: true },
    { at: '11-26 19:00', kind: 'phone', answer: true },
];

// Her claude.ai export (Claude's format: chat_messages, sender "human"), read through the import.
export const claudeExport: Array<{ at: string; title: string; mine: string[] }> = [
    { at: '2026-09-02T09:30:00+05:30', title: 'Night shift sleep', mine: ['how do i sleep during the day after night shifts? my daughter gets home at 3'] },
    { at: '2026-09-20T17:00:00+05:30', title: 'CCRN', mine: ['what is the ccrn exam and how long do people usually prepare for it?'] },
    { at: '2026-10-12T16:45:00+05:30', title: 'Spanish', mine: ['best way to learn spanish in 10 minutes a day? i keep quitting apps'] },
    { at: '2026-11-01T08:30:00+05:30', title: 'Back pain', mine: ['lower back pain after lifting patients, when should a nurse get it checked?'] },
];

export const meera: Person = {
    key: 'meera',
    name: 'Meera Kulkarni',
    email: 'meera@sim.test',
    tz: 'Asia/Kolkata',
    buddyName: 'Saathi',
    tone: 'gentle',
    start: '2026-11-22T20:00:00+05:30',
    end: '2026-11-26T23:30:00+05:30',
    quiet: ['09:00', '16:00'],
    profile:
        'Meera, 31, an ICU nurse in Pune on rotating night shifts (sleeps 09:00 to 16:00 after a night), a mother of a 7-year-old daughter, Anika. Preparing for a nursing certification in March; learning Spanish 10 minutes a day. Writes short, lower case, warm, tired after shifts.',
    truth,
    planted: [
        { key: 'S1', what: 'Spanish 10 minutes a day (a habit)', find: /spanish|duolingo/i, words: /spanish|duolingo/i },
        { key: 'S2', what: 'Her certification exam in March (a plan with a later time)', find: /ccrn|certif|exam/i, words: /ccrn|certif|exam/i },
        { key: 'S3', what: "Her daughter's school play, Friday 17:00", find: /play|anika|school/i, words: /school play|anika/i },
        { key: 'S4', what: 'Her back pain and an MRI (health)', find: /back|mri|physio|pain/i, words: /back pain|\bmri\b|physio|\bback\b|lifting/i, private: true },
    ],
    moments: [{ key: 'N1', what: 'Her exam in March stays silent this week', from: '2026-11-23T17:00:00+05:30', until: '2026-11-26T23:30:00+05:30', thread: 'S2', expect: 'no_ask' }],
    answer: (q) => {
        if (/spanish/i.test(`${q.text} ${q.thread ?? ''}`)) {
            const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(q.at);
            const did = /did spanish|spanish on the break/i.test(truth[day] ?? '');
            const m = did ? 'done' : 'skipped';
            return q.answers.some((a) => a.meaning === m) ? { meaning: m } : { text: did ? 'yes, did it' : 'not today' };
        }
        if (/keep an eye/i.test(q.text)) return q.answers.some((a) => a.meaning === 'yes') ? { meaning: 'yes' } : null;
        return null;
    },
    events,
    seed: [{ tool: 'create_subject', input: { name: 'CCRN prep' } }],
    probeDays: [],
    pronouns: 'she',
};
