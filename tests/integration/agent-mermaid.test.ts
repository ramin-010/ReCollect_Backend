// ```mermaid blocks checked on write (AGENT_DIAGRAMS_PLAN §5, step 4): every agent write path refuses
// a block Mermaid can't parse with a 400 that carries Mermaid's own message, and stores nothing; a
// valid block is stored as written.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('upfly', async () => (await import('../helpers/uploads')).createUpflyMock());
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));

import { prisma } from '../../src/db/prisma';
import { docJsonToYjsState } from '../../src/services/docs/docContent';
import { markdownToDocJson } from '../../src/services/docs/markdown/docMarkdown';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    // Hocuspocus logs every (direct) connection.
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

const fence = (...lines: string[]) => ['```mermaid', ...lines, '```'].join('\n');
const VALID = fence('erDiagram', '  USER ||--o{ ORDER : places');
const BROKEN = fence('sequenceDiagram', '  Alice->>Bob: Hello', '  Bob-->>Alice: Hi', '  Alice->>Bob', '  Bob-->>Alice: ok');
/** BROKEN is the second Mermaid block of `${VALID}\n\n${BROKEN}`. */
const MESSAGE = [
    'Mermaid block 2 (sequenceDiagram), line 4: Parse error on line 4:',
    '...ce: Hi  Alice->>Bob  Bob-->>Alice: ok',
    '----------------------^',
    "Expecting 'TXT', got 'NEWLINE'",
].join('\n');

async function agentFor(user: { id: string }) {
    const { token } = await createTestToken(user);
    return asAgent(token, 'Claude Code');
}

async function docFromMarkdown(userId: string, md: string) {
    return prisma.doc.create({ data: { userId, title: 'Flows', yjsState: docJsonToYjsState(markdownToDocJson(md)) } });
}

describe('a broken ```mermaid block is refused on every agent write, and nothing is stored', () => {
    it("append_to_doc: 400 with Mermaid's message naming the block; the doc, its snapshots and the edit log are untouched", async () => {
        const user = await createTestUser();
        const doc = await docFromMarkdown(user.id, '## Login\n\nfirst');
        const before = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        const agent = await agentFor(user);

        const res = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: `## Flow\n\n${VALID}\n\n${BROKEN}` });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe(MESSAGE);
        expect(await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).toEqual(before);
        expect(await prisma.agentEdit.count({ where: { docId: doc.id } })).toBe(0);
        expect(await prisma.docSnapshot.count({ where: { docId: doc.id } })).toBe(0);

        // Fixed, the same call goes through, and both blocks are stored as written.
        const fixedBlock = BROKEN.replace('  Alice->>Bob\n', '  Alice->>Bob: again\n');
        const fixed = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: `## Flow\n\n${VALID}\n\n${fixedBlock}` });
        expect(fixed.status).toBe(200);
        expect((await agent.get(`/api/agent/docs/${doc.id}`)).body.data.markdown).toBe(`## Login\n\nfirst\n\n## Flow\n\n${VALID}\n\n${fixedBlock}`);
    });

    it('create_doc and replace_section refuse it the same way; the editor paste route lets it through', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const created = await agent.post('/api/agent/docs', { title: 'Flows', markdown: `${VALID}\n\n${BROKEN}` });
        expect(created.status).toBe(400);
        expect(created.body.message).toBe(MESSAGE);
        expect(await prisma.doc.count({ where: { userId: user.id } })).toBe(0);

        const doc = await docFromMarkdown(user.id, '## Flow\n\nold\n\n## Next\n\nkeep');
        const before = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        const replaced = await agent.post(`/api/agent/docs/${doc.id}/replace-section`, { heading: 'Flow', markdown: `${VALID}\n\n${BROKEN}` });
        expect(replaced.status).toBe(400);
        expect(replaced.body.message).toBe(MESSAGE);
        expect(await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).toEqual(before);

        // Ramin's own paste is lenient (the browser shows Mermaid's error on the block; see markdown-paste.test.ts).
        const pasted = await api(user).post('/api/agent/markdown', { markdown: BROKEN });
        expect(pasted.status).toBe(200);
    });
});
