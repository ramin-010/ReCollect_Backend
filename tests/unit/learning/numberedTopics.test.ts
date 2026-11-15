// Course numbers in titles read into a path's order (SYNC_SPINE_SPEC 1.1).
import { describe, expect, it } from 'vitest';
import { numberedPathOrder, parseNumberedTitle } from '../../../src/services/learningDb/numberedTopics';

describe('parseNumberedTitle', () => {
    it('reads the usual ways people number a course', () => {
        expect(parseNumberedTitle('01 · How the web works')).toEqual({ num: 1, sub: 0, letter: '', rest: 'How the web works' });
        expect(parseNumberedTitle('5b · Consistent hashing')).toEqual({ num: 5, sub: 0, letter: 'b', rest: 'Consistent hashing' });
        expect(parseNumberedTitle('02. Caching')).toMatchObject({ num: 2, rest: 'Caching' });
        expect(parseNumberedTitle('3 - Queues')).toMatchObject({ num: 3, rest: 'Queues' });
        expect(parseNumberedTitle('12) Machine coding')).toMatchObject({ num: 12, rest: 'Machine coding' });
        expect(parseNumberedTitle('02.1 · Cache invalidation')).toMatchObject({ num: 2, sub: 1, rest: 'Cache invalidation' });
        expect(parseNumberedTitle('  07 — Search  ')).toMatchObject({ num: 7, rest: 'Search' });
    });

    it('leaves alone what is not a course number', () => {
        expect(parseNumberedTitle('Binary search')).toBeNull();
        expect(parseNumberedTitle('100 days of code')).toBeNull();
        expect(parseNumberedTitle('2024 plans')).toBeNull();
        expect(parseNumberedTitle('01 · ')).toBeNull();
    });
});

describe('numberedPathOrder', () => {
    it('numbered first (5 before 5b before 6), the rest after in their current order', () => {
        const topics = ['Rate limiter', '06 · Queues', '05 · Caching', 'Binary search', '05b · Consistent hashing', '01 · How the web works'].map((title) => ({ title }));
        expect(numberedPathOrder(topics).map((x) => x.topic.title)).toEqual([
            '01 · How the web works',
            '05 · Caching',
            '05b · Consistent hashing',
            '06 · Queues',
            'Rate limiter',
            'Binary search',
        ]);
    });

    it('two topics with the same number keep their current order', () => {
        const topics = ['02 · B', '02 · A'].map((title) => ({ title }));
        expect(numberedPathOrder(topics).map((x) => x.topic.title)).toEqual(['02 · B', '02 · A']);
    });
});
