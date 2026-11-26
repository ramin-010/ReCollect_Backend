// STUDY_FLOW_PLAN (11-23): a lesson's revision card (its last section, pointed at by Doc.cardBlockId, shown first at a
// review) and the notes and links on a lesson or a subject that chats add, read, change, move, merge and remove, each
// with an Undo; a note attached to nothing (the Inbox) stays the person's own.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('upfly', async () => (await import('../helpers/uploads')).createUpflyMock());
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));

import { prisma } from '../../src/db/prisma';
import { stateBytes } from '../../src/services/docs/docState';
import { BLOCKS_FRAGMENT, blocksToYElements, readBlocks, type DocBlock, type InlineNode, type NewBlock } from '../../src/services/docs/blocks/serverEditor';
import { addDays, dayOf } from '../../src/services/learning';
import { createTestUser } from '../helpers/auth';
import { api, createChainRows } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

const t = (text: string): InlineNode => ({ type: 'text', text, styles: {} });

async function blocksDoc(userId: string, title: string, blocks: NewBlock[]) {
    const ydoc = new Y.Doc();
    const group = new Y.XmlElement('blockGroup');
    ydoc.getXmlFragment(BLOCKS_FRAGMENT).insert(0, [group]);
    group.insert(0, blocksToYElements(blocks));
    ydoc.getMap('metadata').set('title', title);
    const yjsState = stateBytes(Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    return prisma.doc.create({ data: { userId, title, yjsState } });
}

async function stored(docId: string): Promise<DocBlock[]> {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, row.yjsState!);
    const blocks = readBlocks(ydoc);
    ydoc.destroy();
    return blocks;
}

const text = (b: DocBlock) => (Array.isArray(b.content) ? (b.content as InlineNode[]).map((n) => (n.type === 'text' ? n.text : n.content.map((c) => c.text).join(''))).join('') : '');
const shape = async (docId: string) => (await stored(docId)).map((b) => `${b.type}${b.type === 'heading' ? `${b.props['level']}` : ''}:${text(b)}`);

/** A lesson in parts (level 2), each with a sub-section (level 3). */
const lesson = (): NewBlock[] => [
    { id: 'h1', type: 'heading', props: { level: 2 }, content: [t('Part 1. The big picture')] },
    { id: 'p1', type: 'paragraph', content: [t('A request goes through nine steps.')] },
    { id: 'h2', type: 'heading', props: { level: 2 }, content: [t('Part 2. DNS')] },
    { id: 'h2a', type: 'heading', props: { level: 3 }, content: [t('How a name finds its address')] },
    { id: 'p2', type: 'paragraph', content: [t('The resolver asks the root, then the TLD, then the authoritative server.')] },
    { id: 'z1', type: 'paragraph', content: [] },
];

const CARD = [
    '## Key points',
    '',
    '- A name becomes an address through the resolver.',
    '- Caches at every level keep it fast.',
    '',
    '<details><summary>What does the TLD server answer?</summary>',
    '',
    'Which server holds the domain.',
    '',
    '</details>',
].join('\n');

async function lessonOnPath(user: { id: string }, title = 'How DNS works') {
    const subject = await prisma.subject.create({ data: { userId: user.id, name: 'Networking' } });
    const doc = await blocksDoc(user.id, title, lesson());
    const topic = await prisma.topic.create({ data: { userId: user.id, subjectId: subject.id, docId: doc.id, title, status: 'in_progress' } });
    return { subject, doc, topic };
}

describe('the revision card (STUDY_FLOW_PLAN §4.4)', () => {
    it('is written as the doc’s last section at its section level, headings inside it below; replaced in place; read for the review; Undo takes it back with its pointer', async () => {
        const user = await createTestUser();
        const { doc, topic } = await lessonOnPath(user);
        const chat = asAgent((await createTestToken(user, ['read', 'docs:write'], 'Claude Code')).token, 'Claude Code');

        const first = await chat.put(`/api/agent/docs/${doc.id}/card`, { markdown: `# Revision card\n\n${CARD}` });
        expect(first.status).toBe(200);
        expect(first.body.data).toMatchObject({ id: doc.id, heading: 'Revision card', replaced: false, editId: expect.any(String) });
        const s1 = await shape(doc.id);
        // After the lesson, before the editor's trailing empty paragraph; its own "##" heading taken as the title, the
        // "## Key points" inside it moved below the card's level.
        expect(s1.slice(0, 9)).toEqual([
            'heading2:Part 1. The big picture',
            'paragraph:A request goes through nine steps.',
            'heading2:Part 2. DNS',
            'heading3:How a name finds its address',
            'paragraph:The resolver asks the root, then the TLD, then the authoritative server.',
            'heading2:Revision card',
            'heading3:Key points',
            'bulletListItem:A name becomes an address through the resolver.',
            'bulletListItem:Caches at every level keep it fast.',
        ]);
        expect(s1.filter((l) => l === 'heading2:Revision card')).toHaveLength(1);
        expect(s1[s1.length - 1]).toBe('paragraph:');
        const cardId = (await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).cardBlockId;
        expect(cardId).toBe((await stored(doc.id)).find((b) => text(b) === 'Revision card')!.id);
        const edit = await prisma.agentEdit.findUniqueOrThrow({ where: { id: first.body.data.editId } });
        expect([edit.kind, edit.summary]).toEqual(['doc_blocks', 'Wrote the revision card in "How DNS works"']);

        // read_doc says it has one, and so does the doc page's topic (its Card button).
        expect((await chat.get(`/api/agent/docs/${doc.id}`)).body.data).toMatchObject({ card: true, notes: 0, topicId: topic.id });
        expect((await api(user).get(`/api/topics/by-doc/${doc.id}`)).body.data.hasCard).toBe(true);

        // The app reads it to draw it: its heading and blocks only, as a Y.Doc state; no review yet.
        const read = await api(user).get(`/api/docs/${doc.id}/card`);
        expect(read.status).toBe(200);
        expect(read.body.data).toMatchObject({ docId: doc.id, title: 'How DNS works', heading: 'Revision card', topicId: topic.id, review: null });
        const y = new Y.Doc();
        Y.applyUpdate(y, Uint8Array.from(Buffer.from(read.body.data.state, 'base64')));
        const cardBlocks = readBlocks(y).map(text);
        y.destroy();
        expect(cardBlocks[0]).toBe('Revision card');
        expect(cardBlocks).not.toContain('Part 1. The big picture');
        // Tokens never call the app's read (they read the doc itself).
        expect((await chat.get(`/api/docs/${doc.id}/card`)).status).toBe(403);

        // Renamed by them, then replaced by a chat: the same heading (their name for it), new content.
        const blocks = await stored(doc.id);
        const heading = blocks.find((b) => b.id === cardId)!;
        const rename = await chat.patch(`/api/agent/docs/${doc.id}/blocks/${heading.id}`, { markdown: '## Review card' });
        expect(rename.status).toBe(200);
        const second = await chat.put(`/api/agent/docs/${doc.id}/card`, { markdown: '- Only this point now.' });
        expect(second.body.data).toMatchObject({ replaced: true, heading: 'Review card' });
        const after = await shape(doc.id);
        expect(after.slice(5)).toEqual(['heading2:Review card', 'bulletListItem:Only this point now.', 'paragraph:']);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).cardBlockId).toBe(cardId);

        // Undo of the replacement: the first card's content is back; the pointer stays.
        expect((await api(user).post(`/api/agent/edits/${second.body.data.editId}/undo`)).status).toBe(200);
        expect((await shape(doc.id)).slice(6, 9)).toEqual(['heading3:Key points', 'bulletListItem:A name becomes an address through the resolver.', 'bulletListItem:Caches at every level keep it fast.']);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).cardBlockId).toBe(cardId);
    });

    it('Undo of the first card leaves no card; a deleted heading means no card; a review row says whether its doc has one and the card names its review', async () => {
        const user = await createTestUser();
        const { doc, topic } = await lessonOnPath(user);
        const chat = asAgent((await createTestToken(user, ['read', 'docs:write'], 'Claude Code')).token, 'Claude Code');
        const first = await chat.put(`/api/agent/docs/${doc.id}/card`, { markdown: CARD });
        expect((await api(user).post(`/api/agent/edits/${first.body.data.editId}/undo`)).status).toBe(200);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).cardBlockId).toBeNull();
        expect((await api(user).get(`/api/docs/${doc.id}/card`)).status).toBe(404);
        expect((await shape(doc.id)).some((l) => l.includes('Revision card'))).toBe(false);

        // Written again, then its heading deleted by them: no card (and the next write makes a new one).
        await chat.put(`/api/agent/docs/${doc.id}/card`, { markdown: CARD });
        const cardId = (await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).cardBlockId!;
        expect((await chat.post(`/api/agent/docs/${doc.id}/blocks/delete`, { ids: [cardId] })).status).toBe(200);
        expect((await api(user).get(`/api/docs/${doc.id}/card`)).status).toBe(404);
        expect((await chat.get(`/api/agent/docs/${doc.id}`)).body.data.card).toBe(false);
        const again = await chat.put(`/api/agent/docs/${doc.id}/card`, { markdown: '- A fresh card.' });
        expect(again.body.data.replaced).toBe(false);

        // The review: cycle 1 due today. Home's row says the doc has a card; the card names the review.
        const today = dayOf(new Date(), 'Asia/Kolkata');
        await prisma.user.update({ where: { id: user.id }, data: { timezone: 'Asia/Kolkata' } });
        await createChainRows(user.id, { topicId: topic.id }, addDays(today, -1));
        const home = await api(user).get('/api/today');
        const rows = [...home.body.data.revisions.dueToday, ...home.body.data.plan.planned];
        expect(rows.some((r: { docId?: string; hasCard?: boolean }) => r.docId === doc.id && r.hasCard === true)).toBe(true);
        const card = await api(user).get(`/api/docs/${doc.id}/card`);
        expect(card.body.data.review).toMatchObject({ cycle: 1, of: 4, scheduledFor: today, due: true, revisionId: expect.any(String) });
    });

    it('is refused for a viewer, a read token and an empty card; a card with a board keeps its board for the review', async () => {
        const user = await createTestUser();
        const { doc } = await lessonOnPath(user);
        const reader = asAgent((await createTestToken(user, ['read'], 'Claude Code')).token, 'Claude Code');
        expect((await reader.put(`/api/agent/docs/${doc.id}/card`, { markdown: CARD })).status).toBe(403);
        const chat = asAgent((await createTestToken(user, ['read', 'docs:write'], 'Claude Code')).token, 'Claude Code');
        expect((await chat.put(`/api/agent/docs/${doc.id}/card`, { markdown: '## Revision card' })).status).toBe(400);
        const stranger = asAgent((await createTestToken(await createTestUser(), ['read', 'docs:write'], 'Claude Code')).token, 'Claude Code');
        expect((await stranger.put(`/api/agent/docs/${doc.id}/card`, { markdown: CARD })).status).toBe(404);

        const board = '```canvas\nflowchart\n  b([Browser]) --> r[Resolver] --> root[Root server]\n  r --> tld[TLD server]\n  r --> auth[(Authoritative)]\n```';
        const res = await chat.put(`/api/agent/docs/${doc.id}/card`, { markdown: `- The resolver does the walking.\n\n${board}` });
        expect(res.status).toBe(200);
        expect(res.body.data.canvases).toHaveLength(1);
        const read = await api(user).get(`/api/docs/${doc.id}/card`);
        const y = new Y.Doc();
        Y.applyUpdate(y, Uint8Array.from(Buffer.from(read.body.data.state, 'base64')));
        const canvasId = res.body.data.canvases[0].canvasId as string;
        expect(y.getMap(`canvas:${canvasId}:nodes`).size).toBeGreaterThan(0);
        y.destroy();
    });
});

describe('notes and links on a lesson or a subject (STUDY_FLOW_PLAN §4.3)', () => {
    it('a chat adds a note to a lesson and a link to a subject; a repeat is not added twice; read back by lesson, by subject (with its lessons), by id', async () => {
        const user = await createTestUser();
        const { subject, doc, topic } = await lessonOnPath(user);
        const chat = asAgent((await createTestToken(user, ['read', 'learning:write'], 'Claude Code')).token, 'Claude Code');

        const note = await chat.post('/api/agent/notes', { docId: doc.id, title: 'Why DNS uses UDP', markdown: 'One small question, one small answer: no handshake needed.' });
        expect(note.status).toBe(201);
        expect(note.body.data).toMatchObject({ kind: 'note', title: 'Why DNS uses UDP', lesson: { docId: doc.id, title: 'How DNS works' }, subject: 'Networking', editId: expect.any(String) });
        const row = await prisma.capture.findUniqueOrThrow({ where: { id: note.body.data.id } });
        expect(row).toMatchObject({ topicId: topic.id, subjectId: subject.id, createdBy: 'agent', agentName: 'Claude Code', type: 'NOTE' });
        const edit = await prisma.agentEdit.findUniqueOrThrow({ where: { id: note.body.data.editId } });
        expect([edit.kind, edit.summary, edit.docId]).toEqual(['pocket_add', 'Added a note to "How DNS works": "Why DNS uses UDP"', doc.id]);

        const link = await chat.post('/api/agent/notes', { subject: 'networking', title: 'DNS explained in 10 minutes', url: 'https://www.youtube.com/watch?v=abc123' });
        expect(link.body.data).toMatchObject({ kind: 'link', lesson: null, subject: 'Networking' });
        expect((await prisma.agentEdit.findUniqueOrThrow({ where: { id: link.body.data.editId } })).summary).toBe('Saved a link on "Networking": "DNS explained in 10 minutes"');
        // The same again (another app, other casing; the same link): not added twice.
        const twice = await chat.post('/api/agent/notes', { docId: doc.id, title: 'why dns uses udp', markdown: 'One small question,  one small answer: no handshake needed.' });
        expect(twice.body.data).toMatchObject({ already: true, id: note.body.data.id, editId: null });
        expect((await chat.post('/api/agent/notes', { subject: 'Networking', title: 'Another name', url: 'http://youtube.com/watch?v=abc123/' })).body.data.already).toBe(true);

        // Their own note in the Inbox (no subject) is never shown to a chat.
        const inbox = await api(user).post('/api/captures', { title: 'My private thought', content: 'Not for chats.' });
        const inboxId = inbox.body.data.capture._id as string;

        const byLesson = await chat.get(`/api/agent/notes?docId=${doc.id}`);
        expect(byLesson.body.data.notes.map((n: { title: string }) => n.title)).toEqual(['Why DNS uses UDP']);
        expect(byLesson.body.data.place).toEqual({ lesson: { docId: doc.id, title: 'How DNS works' }, page: null, subject: 'Networking' });
        const bySubject = await chat.get('/api/agent/notes?subject=Networking');
        expect(bySubject.body.data.notes.map((n: { title: string }) => n.title)).toEqual(['DNS explained in 10 minutes']);
        const withLessons = await chat.get('/api/agent/notes?subject=Networking&lessons=1');
        expect(withLessons.body.data.notes.map((n: { title: string; lesson: unknown }) => [n.title, n.lesson])).toEqual([
            ['DNS explained in 10 minutes', null],
            ['Why DNS uses UDP', { docId: doc.id, title: 'How DNS works' }],
        ]);
        const byIds = await chat.get(`/api/agent/notes?ids=${note.body.data.id},${inboxId}`);
        expect(byIds.body.data.notes.map((n: { id: string }) => n.id)).toEqual([note.body.data.id]);
        expect(byIds.body.data.notes[0]).toMatchObject({ by: 'Claude Code', text: 'One small question, one small answer: no handshake needed.' });
        // read_doc counts the lesson's notes; the app's own list gives the doc's sidebar the same, with who wrote each.
        expect((await chat.get(`/api/agent/docs/${doc.id}`)).body.data.notes).toBe(1);
        const sidebar = await api(user).get(`/api/captures?topicId=${topic.id}&limit=200`);
        expect(sidebar.body.data.map((c: { title: string; createdBy: string; agentName: string; lesson: unknown }) => [c.title, c.createdBy, c.agentName, c.lesson])).toEqual([
            ['Why DNS uses UDP', 'agent', 'Claude Code', { docId: doc.id, title: 'How DNS works' }],
        ]);
        const subjectOwn = await api(user).get(`/api/captures?subjectId=${subject.id}&limit=200`);
        expect(subjectOwn.body.data.map((c: { title: string }) => c.title)).toEqual(['DNS explained in 10 minutes']);

        // Where it can't go: a doc on no path, an unknown subject, neither, a read token.
        const loose = await blocksDoc(user.id, 'Loose doc', lesson());
        expect((await chat.post('/api/agent/notes', { docId: loose.id, title: 'x', markdown: 'y' })).status).toBe(409);
        expect((await chat.get(`/api/agent/notes?docId=${loose.id}`)).body.data).toEqual({ place: null, notes: [], more: null });
        const unknown = await chat.post('/api/agent/notes', { subject: 'Cooking', title: 'x', markdown: 'y' });
        expect(unknown.status).toBe(404);
        expect(unknown.body.message).toContain('Their subjects: Networking.');
        expect((await chat.post('/api/agent/notes', { title: 'x', markdown: 'y' })).status).toBe(400);
        expect((await chat.post('/api/agent/notes', { subject: 'Networking', title: 'x' })).status).toBe(400);
        const reader = asAgent((await createTestToken(user, ['read'], 'Claude Code')).token, 'Claude Code');
        expect((await reader.post('/api/agent/notes', { subject: 'Networking', title: 'x', markdown: 'y' })).status).toBe(403);
        expect((await reader.get('/api/agent/notes?subject=Networking')).status).toBe(200);
    });

    it('a chat changes, moves, merges and removes notes (their own too); each Undo puts it back, a removed note with its reviews', async () => {
        const user = await createTestUser();
        const { doc, topic } = await lessonOnPath(user);
        const chat = asAgent((await createTestToken(user, ['read', 'learning:write'], 'Claude Code')).token, 'Claude Code');
        // Their own note on the lesson, on revision (from Ctrl K).
        const mine = await api(user).post('/api/captures', { title: 'Resolver caches', content: 'My resolver keeps answers for the TTL.', topicId: topic.id, revise: true });
        const mineId = mine.body.data.capture._id as string;
        const reviews = await prisma.revision.count({ where: { captureId: mineId } });
        expect(reviews).toBe(4);
        const other = await chat.post('/api/agent/notes', { docId: doc.id, title: 'TTL', markdown: 'How long an answer may be kept.' });

        // Change: the text and the title; Undo puts both back.
        const changed = await chat.patch(`/api/agent/notes/${mineId}`, { title: 'Resolver caches (TTL)', markdown: 'My resolver keeps answers for the TTL, then asks again.' });
        expect(changed.status).toBe(200);
        expect(changed.body.data).toMatchObject({ id: mineId, title: 'Resolver caches (TTL)', editId: expect.any(String) });
        expect((await prisma.agentEdit.findUniqueOrThrow({ where: { id: changed.body.data.editId } })).summary).toBe('Changed the note "Resolver caches"');
        expect((await api(user).post(`/api/agent/edits/${changed.body.data.editId}/undo`)).status).toBe(200);
        expect(await prisma.capture.findUniqueOrThrow({ where: { id: mineId } })).toMatchObject({ title: 'Resolver caches', content: 'My resolver keeps answers for the TTL.' });

        // Move to the subject; Undo moves it back to the lesson.
        const moved = await chat.patch(`/api/agent/notes/${other.body.data.id}`, { subject: 'Networking' });
        expect((await prisma.agentEdit.findUniqueOrThrow({ where: { id: moved.body.data.editId } })).summary).toBe('Moved the note "TTL" to "Networking"');
        expect((await prisma.capture.findUniqueOrThrow({ where: { id: other.body.data.id } })).topicId).toBeNull();
        expect((await api(user).post(`/api/agent/edits/${moved.body.data.editId}/undo`)).status).toBe(200);
        expect((await prisma.capture.findUniqueOrThrow({ where: { id: other.body.data.id } })).topicId).toBe(topic.id);

        // Merge: the one that stays gets both texts, the other goes "into" it; Undo brings it back with its reviews.
        await chat.patch(`/api/agent/notes/${other.body.data.id}`, { markdown: 'How long an answer may be kept. My resolver keeps answers for the TTL.' });
        const merged = await chat.post(`/api/agent/notes/${mineId}/remove`, { into: other.body.data.id });
        expect(merged.body.data).toMatchObject({ id: mineId, removed: true, into: other.body.data.id });
        expect((await prisma.agentEdit.findUniqueOrThrow({ where: { id: merged.body.data.editId } })).summary).toBe('Merged the note "Resolver caches" into "TTL"');
        expect(await prisma.capture.findUnique({ where: { id: mineId } })).toBeNull();
        expect(await prisma.revision.count({ where: { captureId: mineId } })).toBe(0);
        expect((await api(user).post(`/api/agent/edits/${merged.body.data.editId}/undo`)).status).toBe(200);
        expect(await prisma.capture.findUniqueOrThrow({ where: { id: mineId } })).toMatchObject({ title: 'Resolver caches', topicId: topic.id, createdBy: 'user' });
        expect(await prisma.revision.count({ where: { captureId: mineId, status: 'pending' } })).toBe(4);

        // An added note's Undo removes it.
        const added = await chat.post('/api/agent/notes', { docId: doc.id, title: 'Glue records', markdown: 'An address given with the name server.' });
        expect((await api(user).post(`/api/agent/edits/${added.body.data.editId}/undo`)).status).toBe(200);
        expect(await prisma.capture.findUnique({ where: { id: added.body.data.id } })).toBeNull();

        // Refused: their Inbox note, a note of someone else, merging into itself, emptying a note.
        const inbox = await api(user).post('/api/captures', { title: 'Inbox only', content: 'x' });
        const inboxId = inbox.body.data.capture._id as string;
        expect((await chat.patch(`/api/agent/notes/${inboxId}`, { title: 'y' })).status).toBe(404);
        expect((await chat.post(`/api/agent/notes/${inboxId}/remove`)).status).toBe(404);
        expect((await chat.post(`/api/agent/notes/${mineId}/remove`, { into: mineId })).status).toBe(400);
        expect((await chat.patch(`/api/agent/notes/${mineId}`, { markdown: '' })).status).toBe(400);
        const stranger = asAgent((await createTestToken(await createTestUser(), ['read', 'learning:write'], 'Claude Code')).token, 'Claude Code');
        expect((await stranger.patch(`/api/agent/notes/${mineId}`, { title: 'y' })).status).toBe(404);
        expect((await stranger.get(`/api/agent/notes?ids=${mineId}`)).body.data.notes).toEqual([]);
    });
});
