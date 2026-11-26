// TOOL_ACCESS_PLAN §6.3, §6.5 (11-27): the web door's call limit per token answers words a model reads and resets
// with its window; the counts add up across flushes (several processes each add their own) and hold no user data.
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { LIMITED_HOUR, LIMITED_MINUTE, flushToolStats, recordToolCall, resetLimitsForTests, takeCall } from '../../src/services/mcp/doorStats';

beforeEach(() => resetLimitsForTests());

describe('the call limit per token', () => {
    it('lets the minute’s calls through, then answers the words; the next minute starts again; the hour holds too', () => {
        const t0 = Date.UTC(2026, 10, 27, 10, 0, 0);
        const limits = { minute: 3, hour: 5 };
        expect([1, 2, 3].map((i) => takeCall('rcl_a', t0 + i, limits))).toEqual([null, null, null]);
        expect(takeCall('rcl_a', t0 + 10, limits)).toBe(LIMITED_MINUTE);
        // Another token has its own.
        expect(takeCall('rcl_b', t0 + 10, limits)).toBeNull();
        expect(takeCall('rcl_a', t0 + 61_000, limits)).toBeNull();
        expect(takeCall('rcl_a', t0 + 62_000, limits)).toBeNull();
        expect(takeCall('rcl_a', t0 + 63_000, limits)).toBe(LIMITED_HOUR);
        expect(takeCall('rcl_a', t0 + 3_601_000, limits)).toBeNull();
    });
});

describe('the counts', () => {
    it('add up across two flushes, per day, door, app, tool, path and outcome; nothing else is kept', async () => {
        const day = new Date('2031-01-02T08:00:00Z');
        await prisma.mcpToolStat.deleteMany({ where: { day: '2031-01-02' } });
        recordToolCall({ door: 'web', app: 'ChatGPT', tool: 'trash_doc', via: 'use_tool', outcome: 'ok', ms: 12 }, day);
        recordToolCall({ door: 'web', app: 'ChatGPT', tool: 'trash_doc', via: 'use_tool', outcome: 'ok', ms: 8 }, day);
        recordToolCall({ door: 'web', app: 'ChatGPT', tool: 'find_tools', via: 'direct', outcome: 'no_match', ms: 3 }, day);
        expect(await flushToolStats()).toBe(2);
        recordToolCall({ door: 'web', app: 'ChatGPT', tool: 'trash_doc', via: 'use_tool', outcome: 'ok', ms: 5 }, day);
        expect(await flushToolStats()).toBe(1);
        expect(await flushToolStats()).toBe(0);
        const rows = await prisma.mcpToolStat.findMany({ where: { day: '2031-01-02' }, orderBy: { tool: 'asc' } });
        expect(rows).toEqual([
            { day: '2031-01-02', door: 'web', app: 'ChatGPT', tool: 'find_tools', via: 'direct', outcome: 'no_match', count: 1, msTotal: 3 },
            { day: '2031-01-02', door: 'web', app: 'ChatGPT', tool: 'trash_doc', via: 'use_tool', outcome: 'ok', count: 3, msTotal: 25 },
        ]);
        await prisma.mcpToolStat.deleteMany({ where: { day: '2031-01-02' } });
    });
});
