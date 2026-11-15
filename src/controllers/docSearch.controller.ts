// GET /api/docs/search?q=&limit= (the Docs library's search), on Postgres full-text:
// src/services/docs/docSearch.service.ts. Agents search through GET /api/agent/docs?query=.
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { SEARCH_LIMIT_MAX, SEARCH_QUERY_MAX, searchDocs } from '../services/docs/docSearch.service';
import { handler, ok, parse } from './learning/common';

const searchSchema = z.object({
    q: z.string().max(SEARCH_QUERY_MAX).optional(),
    limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
});

/** → [{ _id, title, updatedAt, snippet, marks: [[start, end], …] }], best match first (50 at most by default). */
export const searchLibraryDocs = handler(async (req, res) => {
    const { q, limit } = parse(searchSchema, req.query);
    const hits = await searchDocs(requireUser(req).id, { query: q, limit: limit ?? SEARCH_LIMIT_MAX });
    ok(res, hits.map(({ id, ...hit }) => ({ _id: id, ...hit })));
});
