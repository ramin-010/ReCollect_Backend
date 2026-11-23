// Stage 14: a note a chat adds inside a doc's section. The repeat check's threshold is set by these 30 labelled pairs,
// written before the threshold was chosen: 15 repeats (the same note again, in the same or other words, from another
// app) and 15 different notes on the same topic (a new example, a new term, a new insight). A missed repeat leaves one
// visible note to delete; a refused new note loses what helped them, the costlier miss.
import { describe, expect, it } from 'vitest';
import { NOTE_SAME, afterIndex, footerDay, isFooter, noteFooter, noteRepeats, noteShare, sectionUnits } from '../../../src/services/agent/docNotes';

const PAIRS: Array<{ note: string; against: string; same: boolean }> = [
    // ── Repeats ──
    {
        note: '**Conveyor belt picture:** think of the sorted array as a conveyor belt with a worker at each end. Too light together: the left worker takes a heavier box. Too heavy: the right worker takes a lighter one.',
        against: '**Conveyor belt picture:** think of the sorted array as a conveyor belt with a worker at each end. Too light together: the left worker takes a heavier box. Too heavy: the right worker takes a lighter one.',
        same: true,
    },
    {
        note: "**The conveyor belt example:** the array is a sorted conveyor belt and there's a worker at both ends. When the pair is too light, the left worker picks the next, heavier box; when it's too heavy, the right worker takes a lighter one.",
        against: '**Conveyor belt picture:** think of the sorted array as a conveyor belt with a worker at each end. Too light together: the left worker takes a heavier box. Too heavy: the right worker takes a lighter one.',
        same: true,
    },
    {
        note: '**Idempotent (the term):** repeating the request has the same effect as sending it once; that is why retrying a PUT never makes a second order.',
        against: "**Idempotent:** doing it twice leaves the same result as doing it once, so a retried PUT can't create a second order.",
        same: true,
    },
    {
        note: '**The loop condition:** use lo <= hi, because lo < hi exits with one element left unchecked and misses a target sitting in that last spot.',
        against: '**Why `lo <= hi`:** with `lo < hi` the loop stops while one element is still unchecked, so a target in the last spot is missed.',
        same: true,
    },
    {
        note: '**Clock face picture:** servers and keys sit on a circle like a clock; a key belongs to the first server clockwise from it, so when a server leaves only its own keys move to the next one.',
        against: '**Ring example:** put servers and keys on a clock face; each key goes to the next server clockwise, so removing one server only moves the keys that sat just before it.',
        same: true,
    },
    {
        note: '**Deadlock needs all four:** mutual exclusion, hold-and-wait, no preemption, circular wait. Remove one of them and a deadlock is impossible.',
        against: "**The four conditions:** mutual exclusion, hold and wait, no preemption and circular wait must all hold; break any one and deadlock can't happen.",
        same: true,
    },
    {
        note: '**The notebook analogy for memoization:** look in the notebook before computing fib(n) and write the answer in after; every value is computed only once, which takes it from exponential time to linear.',
        against: '**Memo = a notebook:** before computing fib(n), check the notebook; after computing it, write it down. Each value is computed once, so it drops from exponential to linear.',
        same: true,
    },
    {
        note: "**LEFT JOIN:** keeps all rows of the left table, and fills the right table's columns with NULL when nothing matches.",
        against: '**LEFT JOIN in one line:** every row from the left table stays; where the right table has no match, its columns are NULL.',
        same: true,
    },
    {
        note: '**Partitions and consumers:** within a consumer group a partition goes to one consumer only; with more consumers than partitions, the extra consumers sit idle.',
        against: '**Consumer group rule:** each partition is read by exactly one consumer in a group, so more consumers than partitions leaves some idle.',
        same: true,
    },
    {
        note: '**What CAP actually asks:** network partitions are unavoidable, so during a partition you choose consistency or availability.',
        against: '**CAP, the real choice:** a network partition will happen, so the choice is between consistency and availability while the partition lasts.',
        same: true,
    },
    {
        note: '**Shallow B-tree:** with hundreds of keys per node, a billion rows fit in about four levels: four disk reads to find any row.',
        against: '**Why B-trees are shallow:** each node holds hundreds of keys, so a billion rows need only about four levels, which means four disk reads.',
        same: true,
    },
    {
        note: "**Why three steps:** SYN, then SYN-ACK, then ACK; the last ACK shows the client got the server's sequence number.",
        against: "**Three-way handshake:** SYN, SYN-ACK, ACK; the third step proves the client received the server's sequence number.",
        same: true,
    },
    {
        note: '**The catch with write-back:** writes live only in the cache until the flush; if the cache dies before the flush, those writes are lost.',
        against: '**Write-back risk:** the write sits only in the cache until it is flushed, so a cache crash before the flush loses it.',
        same: true,
    },
    { note: '**Amortized:** the average cost per operation over a long sequence.', against: '**Amortized:** the average cost per operation over a long sequence.', same: true },
    {
        note: '**Fix to the note above:** quicksort is O(n²) in the worst case, not O(n log n), which happens when every pivot is the smallest or the largest element.',
        against: "**Correction:** quicksort's worst case is O(n²), not O(n log n); it happens when the pivot is always the smallest or largest element.",
        same: true,
    },
    // ── Different notes on the same topic ──
    {
        note: "**Why it never misses a pair:** when the sum is too small, the left element can't pair with anything still in range, so dropping it loses no answer.",
        against: '**Conveyor belt picture:** think of the sorted array as a conveyor belt with a worker at each end. Too light together: the left worker takes a heavier box. Too heavy: the right worker takes a lighter one.',
        same: false,
    },
    {
        note: '**POST vs PUT:** POST creates a new resource each time, so a retried POST can create a duplicate order unless it carries an idempotency key.',
        against: "**Idempotent:** doing it twice leaves the same result as doing it once, so a retried PUT can't create a second order.",
        same: false,
    },
    {
        note: '**Finding the first match:** when the target repeats, keep searching left after a hit (hi = mid - 1) and remember the last hit.',
        against: '**Why `lo <= hi`:** with `lo < hi` the loop stops while one element is still unchecked, so a target in the last spot is missed.',
        same: false,
    },
    {
        note: "**Virtual nodes:** each server gets many points on the ring, so the keys spread evenly and a leaving server's keys go to many servers instead of one.",
        against: '**Ring example:** put servers and keys on a clock face; each key goes to the next server clockwise, so removing one server only moves the keys that sat just before it.',
        same: false,
    },
    {
        note: '**Avoiding circular wait:** number the locks and always take them in that order; then no cycle can form.',
        against: "**The four conditions:** mutual exclusion, hold and wait, no preemption and circular wait must all hold; break any one and deadlock can't happen.",
        same: false,
    },
    {
        note: '**Tabulation instead:** fill the table from fib(0) upward in a loop; no recursion, so no stack overflow for a large n.',
        against: '**Memo = a notebook:** before computing fib(n), check the notebook; after computing it, write it down. Each value is computed once, so it drops from exponential to linear.',
        same: false,
    },
    {
        note: '**INNER JOIN:** keeps only rows that match in both tables; unmatched rows from either side are dropped.',
        against: '**LEFT JOIN in one line:** every row from the left table stays; where the right table has no match, its columns are NULL.',
        same: false,
    },
    {
        note: '**Rebalancing:** when a consumer joins or leaves the group, its partitions are reassigned and reading pauses briefly.',
        against: '**Consumer group rule:** each partition is read by exactly one consumer in a group, so more consumers than partitions leaves some idle.',
        same: false,
    },
    {
        note: '**PACELC:** even without a partition there is a trade-off, between latency and consistency.',
        against: '**CAP, the real choice:** a network partition will happen, so the choice is between consistency and availability while the partition lasts.',
        same: false,
    },
    {
        note: '**B+ tree leaves are linked:** the leaves form a linked list, so a range scan walks along the leaves without going back up the tree.',
        against: '**Why B-trees are shallow:** each node holds hundreds of keys, so a billion rows need only about four levels, which means four disk reads.',
        same: false,
    },
    {
        note: '**Four-way close:** FIN, ACK, FIN, ACK, because each side closes its own direction of the connection separately.',
        against: "**Three-way handshake:** SYN, SYN-ACK, ACK; the third step proves the client received the server's sequence number.",
        same: false,
    },
    {
        note: '**Write-through instead:** every write goes to the cache and the database at once, so nothing is lost when the cache crashes, but writes are slower.',
        against: '**Write-back risk:** the write sits only in the cache until it is flushed, so a cache crash before the flush loses it.',
        same: false,
    },
    { note: '**Asymptotic:** how the cost grows as n grows large.', against: '**Amortized:** the average cost per operation over a long sequence.', same: false },
    {
        note: "**Quicksort's average case:** with a random pivot the expected cost is O(n log n), because the splits are balanced on average.",
        against: "**Correction:** quicksort's worst case is O(n²), not O(n log n); it happens when the pivot is always the smallest or largest element.",
        same: false,
    },
    {
        note: '**Conveyor belt picture:** think of the sorted array as a conveyor belt with a worker at each end. Too light together: the left worker takes a heavier box. Too heavy: the right worker takes a lighter one.',
        against: 'Two pointers works on a sorted array: start one pointer at each end and move them toward each other until they meet.',
        same: false,
    },
];

describe('the repeat check (30 labelled pairs)', () => {
    // Measured 11-20 (shares of the note's topic stems): different notes 0.09-0.50; repeats 0.44-1.00, five of them
    // paraphrases at 0.44-0.54. The threshold sits above every different note.
    it('refuses no new note, and catches the same note again (10 of the 15 repeats; the paraphrases are the chat’s to see)', () => {
        const rows = PAIRS.map((p) => ({ ...p, share: noteShare(p.note, p.against), says: noteRepeats(p.note, [p.against]) }));
        if (process.env['SHOW_SHARES']) console.log(rows.map((r) => `${r.same ? 'SAME' : 'DIFF'} ${r.share.toFixed(2)} ${r.says ? 'repeat' : 'new'} · ${r.note.slice(0, 50)}`).join('\n'));
        expect(rows.filter((r) => !r.same && r.says).map((r) => `refused new (${r.share.toFixed(2)}): ${r.note.slice(0, 60)}`)).toEqual([]);
        expect(rows.filter((r) => r.same && r.says).length).toBeGreaterThanOrEqual(10);
        // Every verbatim or near-verbatim repeat is caught.
        expect(rows.filter((r) => r.same && r.share >= 0.75).every((r) => r.says)).toBe(true);
        expect(Math.max(...rows.filter((r) => !r.same).map((r) => r.share))).toBeLessThan(NOTE_SAME);
    });
});

describe('placing a note', () => {
    const section = ['Two pointers works on a sorted array.', 'Start one pointer at each end and move them toward each other.', 'It runs in O(n).'];
    it('after the block that holds the quoted words (case and punctuation aside), else the end', () => {
        expect(afterIndex(section, 'start one pointer at each END')).toBe(1);
        expect(afterIndex(section, '"Two pointers works"')).toBe(0);
        expect(afterIndex(section, 'not in this section')).toBe(-1);
        expect(afterIndex(section, '')).toBe(-1);
        expect(afterIndex(section, undefined)).toBe(-1);
    });

    it('every block is a unit; an earlier note’s blocks before its last line are one more; the last line is none', () => {
        const texts = ['Intro paragraph.', 'Added 18 Nov from Claude', 'Conveyor belt picture: a worker at each end.', 'Heavier box, lighter box.', 'Added 19 Nov from Claude', 'Closing paragraph.'];
        expect(sectionUnits(texts)).toEqual([
            'Intro paragraph.',
            'Conveyor belt picture: a worker at each end.',
            'Heavier box, lighter box.',
            'Conveyor belt picture: a worker at each end.\nHeavier box, lighter box.',
            'Closing paragraph.',
        ]);
    });

    it('a note said again in the section is a repeat; the same words inside a block count; an empty note is no note', () => {
        expect(noteRepeats('It runs in O(n).', section)).toBe(true);
        expect(noteRepeats('runs in O(n)', section)).toBe(true);
        expect(noteRepeats('**Space:** it needs O(1) extra memory.', section)).toBe(false);
        expect(noteRepeats('  ', section)).toBe(true);
    });
});

describe('the last line', () => {
    it('says the day in their zone and the app', () => {
        const at = new Date(Date.UTC(2026, 10, 20, 20, 0));
        expect(footerDay(at, 'Asia/Kolkata')).toBe('21 Nov');
        expect(footerDay(at, 'America/New_York')).toBe('20 Nov');
        expect(noteFooter('20 Nov', 'ChatGPT')).toBe('Added 20 Nov from ChatGPT');
        expect(noteFooter('20 Nov', '  ')).toBe('Added 20 Nov from a chat');
        expect(isFooter('Added 20 Nov from ChatGPT')).toBe(true);
        expect(isFooter('Added a cache in front of the DB')).toBe(false);
    });
});
