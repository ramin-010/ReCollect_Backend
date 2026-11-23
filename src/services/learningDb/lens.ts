// What counts as progress (PERSONAL_OFFICE_PLAN, 11-23). Every session has an area: personal (their own projects,
// study, practice, anything with no folder) or work (a folder marked Work). Each person chooses whether work counts
// as progress (User.progressIncludesWork; off by default): the "progress lens". Everything that judges, praises,
// nudges or shows consistency reads sessions through it: Home's year and week, Where you stand by default, the
// buddy, the brief, the coach, the week's targets. Where you stand can also be looked at through the other lenses.
//
// The rule is kept by one guard (tests/unit/learning/lens-guard.test.ts): a file that reads WorkSession rows must
// filter them with `sessionsOf` / `countedSessions` here, or be on its list of readers that see both areas on purpose
// (the work log, the export, the session list itself).
import type { ProjectKind, SessionArea } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';

export type Lens = 'personal' | 'work' | 'all';
export const LENSES = ['personal', 'work', 'all'] as const satisfies readonly Lens[];
/** The lens that judges: personal only, or personal and work (the person's choice). */
export type ProgressLens = Extract<Lens, 'personal' | 'all'>;
export const PROJECT_KINDS = ['personal', 'study', 'work'] as const satisfies readonly ProjectKind[];

/** A folder's sessions are work only when the folder is. */
export const areaOfKind = (kind: ProjectKind | null | undefined): SessionArea => (kind === 'work' ? 'work' : 'personal');

/** Pure: does a session of this area show under this lens? */
export const inLens = (lens: Lens, area: SessionArea): boolean => lens === 'all' || lens === area;

/** The sessions a lens sees, as a `where` part to spread into a WorkSession query (`{}` sees both). */
export function sessionsOf(lens: Lens): { area?: SessionArea } {
    return lens === 'all' ? {} : { area: lens };
}

/** A folder's key as the server keeps it (Project.key): single spaces, lower case, at most 100 characters. */
export const folderKey = (name: string): string => name.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);

/** The kind of the folder with this key or name, or null when the server doesn't know it. */
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

/** What counts as progress for this person. */
export async function progressLens(userId: string, db: DbClient = prisma): Promise<ProgressLens> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { progressIncludesWork: true } });
    return user?.progressIncludesWork ? 'all' : 'personal';
}

/** The sessions that count as progress for this person, as a `where` part (see `sessionsOf`). */
export async function countedSessions(userId: string, db: DbClient = prisma): Promise<{ area?: SessionArea }> {
    return sessionsOf(await progressLens(userId, db));
}
