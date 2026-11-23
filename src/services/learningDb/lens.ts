// What counts as progress (PERSONAL_OFFICE_PLAN, 11-23). Every session has an area: personal (their own projects,
// study, practice, anything with no folder) or work (a folder marked Work). Each person chooses whether work counts
// as progress (User.progressIncludesWork; off by default): the "progress lens". Everything that judges, praises,
// nudges or shows consistency reads sessions through it: Home's year and week, Where you stand by default, the
// buddy, the brief, the coach, the week's targets. Where you stand can also be looked at through the other lenses.
//
// The rule is kept by one guard (tests/unit/learning/lens-guard.test.ts): a file that reads WorkSession rows must
// filter them with `sessionsOf` / `countedSessions` here, or be on its list of readers that see both areas on purpose
// (the work log, the export, the session list itself).
import type { FolderTracking, KindSetBy, NewFolders, ProjectKind, SessionArea, SessionKind } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';

export type Lens = 'personal' | 'work' | 'all';
export const LENSES = ['personal', 'work', 'all'] as const satisfies readonly Lens[];
/** The lens that judges: personal only, or personal and work (the person's choice). */
export type ProgressLens = Extract<Lens, 'personal' | 'all'>;
export const PROJECT_KINDS = ['personal', 'study', 'work'] as const satisfies readonly ProjectKind[];
/** EASY_SETUP_PLAN: what is logged in a folder (full: everything; light: the time only; off: nothing). */
export const FOLDER_TRACKING = ['full', 'light', 'off'] as const satisfies readonly FolderTracking[];
/** EASY_SETUP_PLAN §3.5: what a folder the server has never seen is (ask: the agent asks them once). */
export const NEW_FOLDERS = ['ask', 'personal', 'study', 'work', 'off'] as const satisfies readonly NewFolders[];

/** A folder's sessions are work only when the folder is. */
export const areaOfKind = (kind: ProjectKind | null | undefined): SessionArea => (kind === 'work' ? 'work' : 'personal');

/** What is logged in a folder: its own choice, else its kind's (work: the time only; personal and study: everything). */
export const trackingOf = (kind: ProjectKind, tracking: FolderTracking | null | undefined): FolderTracking => tracking ?? (kind === 'work' ? 'light' : 'full');

// ─── What a chat is (EASY_SETUP_PLAN §7) ───────────────────────────────
// Every chat (one session) is Personal, Study or Work; its folder only gives the starting value. Personal = area
// personal, a build; Study = area personal, study (practice and review are study too); Work = area work.

export type ChatKind = 'personal' | 'study' | 'work';
export const CHAT_KINDS = ['personal', 'study', 'work'] as const satisfies readonly ChatKind[];

/** What a chat is, read from its area and kind. */
export const chatKindOf = (s: { area: SessionArea; kind: SessionKind }): ChatKind => (s.area === 'work' ? 'work' : s.kind === 'build' ? 'personal' : 'study');

/** The area and kind a chat gets when someone says what it is (a practice or a review marked study stays what it is). */
export function chatKindData(to: ChatKind, kind: SessionKind): { area: SessionArea; kind: SessionKind } {
    if (to === 'work') return { area: 'work', kind: 'build' };
    if (to === 'personal') return { area: 'personal', kind: 'build' };
    return { area: 'personal', kind: kind === 'practice' || kind === 'review' ? kind : 'study' };
}

/** How much each choice weighs: the folder (or a PC's guess) least, then the agent, their own words, the app. */
export const KIND_SET_RANK: Readonly<Record<KindSetBy, number>> = { folder: 0, pc: 0, agent: 1, chat: 2, app: 3 };

/** A choice by `by` replaces one by `was` only when it weighs as much or more (a later, more trusted choice wins). */
export const mayReset = (by: KindSetBy, was: KindSetBy | null | undefined): boolean => KIND_SET_RANK[by] >= KIND_SET_RANK[was ?? 'folder'];

/** Pure: does a session of this area show under this lens? */
export const inLens = (lens: Lens, area: SessionArea): boolean => lens === 'all' || lens === area;

/** The sessions a lens sees, as a `where` part to spread into a WorkSession query (`{}` sees both). */
export function sessionsOf(lens: Lens): { area?: SessionArea } {
    return lens === 'all' ? {} : { area: lens };
}

/** A folder's key as the server keeps it (Project.key): single spaces, lower case, at most 100 characters. */
export const folderKey = (name: string): string => name.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);

/** The kind of the folder with this key or name, or null when the server doesn't know it (see also officeChat). */
export async function folderKindOf(userId: string, folder: string | null | undefined, db: DbClient = prisma): Promise<ProjectKind | null> {
    const key = folder ? folderKey(folder) : '';
    if (!key) return null;
    return (await db.project.findUnique({ where: { userId_key: { userId, key } }, select: { kind: true } }))?.kind ?? null;
}

/**
 * Words and work lines from a folder are office work (kept apart, never in their personal brief) when the PC says so or
 * the server knows the folder as work: the stricter of the two (privacy errs on the safe side).
 */
export async function officeFolder(userId: string, folder: string | null | undefined, pcSaysOffice: boolean | undefined, db: DbClient = prisma): Promise<boolean> {
    if (pcSaysOffice === true) return true;
    return (await folderKindOf(userId, folder, db)) === 'work';
}

/** What a chat is, as the PC tells it with its words: the kind and who said so. */
export interface ChatWord {
    kind: ChatKind;
    by: KindSetBy;
}

/**
 * EASY_SETUP_PLAN §7: a chat's words are office work as their folder says (officeFolder), except where they said
 * themselves what the chat is (their words, /study, the app): a chat they call study or personal in a work folder is
 * theirs. Anyone marking a chat work makes its words office (privacy errs on the safe side).
 */
export async function officeChat(userId: string, folder: string | null | undefined, pcSaysOffice: boolean | undefined, chat: ChatWord | null | undefined, db: DbClient = prisma): Promise<boolean> {
    if (chat?.kind === 'work') return true;
    if (chat && (chat.by === 'chat' || chat.by === 'app')) return false;
    return officeFolder(userId, folder, pcSaysOffice, db);
}

/** What counts as progress for this person. */
export async function progressLens(userId: string, db: DbClient = prisma): Promise<ProgressLens> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { progressIncludesWork: true } });
    return user?.progressIncludesWork ? 'all' : 'personal';
}

/** The sessions that count as progress for this person, as a `where` part (see `sessionsOf`). */
export async function countedSessions(userId: string, db: DbClient = prisma): Promise<{ area?: SessionArea }> {
    return sessionsOf(await progressLens(userId, db));
}
