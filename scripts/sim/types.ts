// The simulation's vocabulary (SIMULATION_PLAN §4): a person's week as timed events, every message labelled
// with what should become of it, written before any model sees it.

/** What should become of a message (§4.2). A planted thread is named by its key (T1…). */
export type Becomes =
    | 'nothing' // never a thread, an event, a memory, a task or a reminder: work talk, code, controls
    | 'memory' // something lasting about the person (a fact, a preference, how they work)
    | 'optional' // either way is fine: not graded
    | `new:${string}` // opens that planted thread
    | `update:${string}` // news on it (what happened)
    | `moved:${string}` // its plan changed (a new day or time)
    | `close:${string}` // the person dropped it
    | `steer:${string}:${'less' | 'none' | 'off_screens'}` // his say over it
    | `nosteer:${string}` // a wish about when (weekends, late at night) is a note, never a steer on that thread (issue 16)
    | `reminder:${'silent' | 'ring' | 'repeat' | 'pin'}`; // the chat should set one (and only that)

export interface Msg {
    text: string;
    /** The agent's reply in a Claude Code session (the hook sends its start with the message). */
    reply?: string;
    /** Should the gate keep it for the buddy? Defaults: keep when it becomes something, drop when 'nothing'. */
    gate?: 'keep' | 'drop';
    becomes?: Becomes | Becomes[];
    /** A control (§5.3): must not be kept or acted on. Its name. */
    control?: string;
    /** Never on a screen (family, health, money). */
    private?: boolean;
}

/** What a chat turn should do (§3 row 7): graded by code from the tools it called. */
export interface ChatExpect {
    tools?: string[]; // each must be called
    noTools?: string[]; // none of these
    ring?: boolean; // a reminder that rings (true) or a silent one (false)
    repeat?: string;
    maxWords?: number;
}

/** A tool an agent calls in a Claude Code session, as an agent following the tool texts would. */
export interface AgentCall {
    tool: string;
    input: Record<string, unknown>;
    after: number; // after his message number (1-based) in the session
}

export type Ev =
    | { at: string; kind: 'session'; key: string; project: string; office?: boolean; messages: Msg[]; calls?: AgentCall[] }
    | { at: string; kind: 'chat'; via: 'ask' | 'tell'; messages: Msg[]; expect?: ChatExpect[]; persona?: number; doc?: string }
    | { at: string; kind: 'phoneTell'; msg: Msg }
    | { at: string; kind: 'phone'; answer: boolean; thumb?: { verdict: 'more' | 'less'; when: string } }
    | { at: string; kind: 'settings'; patch: Record<string, unknown>; why: string }
    | { at: string; kind: 'import'; file: string; limitUsd: number }
    | { at: string; kind: 'relay'; about?: string; said: Msg[] }
    | { at: string; kind: 'remember'; msg: Msg }
    | { at: string; kind: 'pocket'; msg: Msg }
    | { at: string; kind: 'recall'; doc: string; answers: Array<{ grade: 'right' | 'half' | 'wrong'; text: string }> }
    | { at: string; kind: 'taskLine'; prompt: string; expect: { day: string | null; title: RegExp } }
    | { at: string; kind: 'practice'; problem: string; solution: string; struggles: string }
    | { at: string; kind: 'coach' }
    | { at: string; kind: 'home' }; // he opens Home in the browser (the web's questions are marked shown)

/** A planted thread (§5.2): how to find it, and the words that must never reach a screen when private. */
export interface Planted {
    key: string;
    what: string;
    find: RegExp; // a thread's title and keywords
    words: RegExp; // its words on a surface
    private?: boolean;
    /** Steered: from this moment no surface may speak of it (§6.2). */
    silentFrom?: string;
}

/** A come-back moment (§5.4): what a good friend would do, in a window. */
export interface Moment {
    key: string;
    what: string;
    from: string;
    until: string;
    thread: string;
    expect: 'ask' | 'line' | 'no_ask' | 'nothing' | 'may';
}

/** What the person answers to one of the buddy's questions (from the truth calendar), or null to leave it. */
export type AnswerFn = (q: { thread: string | null; text: string; answers: Array<{ label: string; meaning: string }>; at: Date }) => { meaning: string } | { text: string } | null;

export interface Person {
    key: string;
    name: string;
    email: string;
    tz: string;
    buddyName: string;
    tone: string;
    start: string; // the clock's start (setup)
    end: string; // the run's end
    quiet: [string, string]; // his phone's quiet hours (HH:mm)
    profile: string; // for the persona model
    truth: Record<string, string>; // day (YYYY-MM-DD) → what really happened that day (the persona's only facts)
    planted: Planted[];
    moments: Moment[];
    answer: AnswerFn;
    events: Ev[];
    /** The learning data an agent made before the week (through the catalogue). */
    seed: Array<{ tool: string; input: Record<string, unknown> }>;
    /** The probes asked on copies at the end of these days (§6.3). */
    probeDays: string[];
    /** How the person is spoken of; the buddy must never use the others' pronouns about them (§5.5). */
    pronouns?: 'he' | 'she' | 'they';
}
