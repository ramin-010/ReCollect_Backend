// What counts as progress (PERSONAL_OFFICE_PLAN, 11-23). Every session has an area: personal (their own projects,
// study, practice, anything with no folder) or work (a folder marked Work). Each person chooses whether work counts
// as progress (User.progressIncludesWork; off by default): the "progress lens". Everything that judges, praises,
// nudges or shows consistency reads sessions through it: Home's year and week, Where you stand by default, the
// buddy, the brief, the coach, the week's targets. Where you stand can also be looked at through the other lenses.
//
// The rule is kept by one guard (tests/unit/learning/lens-guard.test.ts): a file that reads WorkSession rows must
// filter them with `sessionsOf` / `countedSessions` here, or be on its list of readers that see both areas on purpose
// (the work log, the export, the session list itself).
import type { FolderTracking, KindSetBy, NewFolders, Prisma, ProjectKind, SessionArea, SessionKind } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';

// STUDY_FLOW_PLAN §4.5 (11-23): Personal is two parts, Learning (study, practice, reviews) and Building (their own
// projects: build sessions). Two more lenses look at each part alone; what judges stays on the progress lens.
// What counts as progress is their choice of three ticks (Settings › Tracking): Learning always, Building and Work
// as they pick (User.progressIncludesBuilding, progressIncludesWork). Each mix is a lens: learning, personal
// (learning + building), learning_work, all. Home's graph filter can also look at building_work (no learning).
export type Lens = 'personal' | 'learning' | 'building' | 'work' | 'all' | 'learning_work' | 'building_work';
export const LENSES = ['personal', 'learning', 'building', 'work', 'all', 'learning_work', 'building_work'] as const satisfies readonly Lens[];
/** Lenses that see sessions only: reviews, topics, goals, focus lines and targets are learning. */
export const SESSIONS_ONLY: readonly Lens[] = ['work', 'building', 'building_work'];
/** The session kinds that are learning (a build is building). */
export const LEARNING_KINDS = ['study', 'practice', 'review'] as const satisfies readonly SessionKind[];
/** What people and agents read for a folder's or a chat's kind (the stored values stay personal, study, work). */
export const KIND_WORD: Readonly<Record<ProjectKind, string>> = { personal: 'building', study: 'learning', work: 'work' };
/** The lens that judges: learning, with building and work as the person ticked them. */
export type ProgressLens = Extract<Lens, 'learning' | 'personal' | 'learning_work' | 'all'>;

/** The progress lens of their ticks (learning always counts). */
export const progressLensOf = (building: boolean, work: boolean): ProgressLens => (building ? (work ? 'all' : 'personal') : work ? 'learning_work' : 'learning');
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
// Every chat (one session) is Building, Learning or Work; its folder only gives the starting value. Stored as
// personal (= Building: area personal, a build), study (= Learning: area personal, study; practice and review are
// learning too) and work (area work).

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

/** Pure: does a session of this area (and kind) show under this lens? Learning and Building need the kind. */
export function inLens(lens: Lens, area: SessionArea, kind?: SessionKind): boolean {
    if (lens === 'all') return true;
    const learning = area === 'personal' && kind !== undefined && kind !== 'build';
    if (lens === 'learning') return learning;
    if (lens === 'learning_work') return learning || area === 'work';
    if (lens === 'building') return area === 'personal' && kind === 'build';
    if (lens === 'building_work') return area === 'work' || kind === 'build';
    return lens === area;
}

/** The sessions a lens sees, as a `where` part to spread into a WorkSession query (`{}` sees both). */
export function sessionsOf(lens: Lens): Prisma.WorkSessionWhereInput {
    if (lens === 'all') return {};
    if (lens === 'learning') return { area: 'personal', kind: { in: [...LEARNING_KINDS] } };
    if (lens === 'learning_work') return { OR: [{ area: 'work' }, { area: 'personal', kind: { in: [...LEARNING_KINDS] } }] };
    if (lens === 'building') return { area: 'personal', kind: 'build' };
    if (lens === 'building_work') return { OR: [{ area: 'work' }, { area: 'personal', kind: 'build' }] };
    return { area: lens };
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
    const user = await db.user.findUnique({ where: { id: userId }, select: { progressIncludesWork: true, progressIncludesBuilding: true } });
    return progressLensOf(user?.progressIncludesBuilding ?? true, user?.progressIncludesWork ?? false);
}

/**
 * The sessions that count as progress for this person, as a `where` part (see `sessionsOf`), inside an AND so it
 * never replaces the caller's own kind or OR filter.
 */
export async function countedSessions(userId: string, db: DbClient = prisma): Promise<Prisma.WorkSessionWhereInput> {
    const where = sessionsOf(await progressLens(userId, db));
    return Object.keys(where).length ? { AND: [where] } : {};
}
