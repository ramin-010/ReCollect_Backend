// What an update's words say (MCP_MEMORY_PLAN §4.3, after the live hour of 11-19): whether a statement is about the
// thing an assistant named, and whether it is one day's doing or a change of routine or an end. Pure rules, no AI.
// The two live-hour cases first, then fresh sentences that were never part of any run.
import { describe, expect, it } from 'vitest';
import { aboutThing, dayNewsOf, dayNewsOn, searchRoot, shapeOf, soundsLikeChange, stem, topicCover, topicOverlap, topicStems, updateFromWords } from '../../../src/services/buddy/recordRules';

const WALKING = 'Walking after work walk walking steps';

describe('the two cases from the live hour', () => {
    it('"learning Spanish" is not about walking; one morning\'s walk is that day\'s doing, not a new routine', () => {
        expect(aboutThing('Decided to start learning Spanish for 15 minutes every morning.', WALKING)).toBe('no');
        expect(aboutThing('Got a walk in this morning before standup; 9k steps.', WALKING)).toBe('yes');
        expect(updateFromWords('changed', 'Got a walk in this morning before standup; 9k steps.', true)).toBe('done');
        // A real change of routine stays a change.
        expect(updateFromWords('changed', 'Moved my walks to the evenings, after dinner.', true)).toBe('changed');
        expect(updateFromWords('changed', 'I walk in the mornings now', true)).toBe('changed');
    });
});

describe('stems and topic words', () => {
    it('meet across forms, and leave times, amounts and small verbs out', () => {
        expect(['walk', 'walks', 'walked', 'walking'].map(stem)).toEqual(['walk', 'walk', 'walk', 'walk']);
        expect(['run', 'runs', 'ran', 'running'].map(stem)).toEqual(['run', 'run', 'run', 'run']);
        expect(['study', 'studies', 'studied', 'studying'].map(stem)).toEqual(['study', 'study', 'study', 'study']);
        expect(['practice', 'practiced', 'practicing'].map(stem)).toEqual(['practic', 'practic', 'practic']);
        expect([...topicStems("Didn't get my 10k steps in today, too tired")]).toEqual(['step']);
        expect([...topicStems('Done for today!')]).toEqual([]);
    });
});

describe('about the thing, or not (fresh sentences)', () => {
    const GUITAR = 'Evening guitar practice guitar practice';
    it('a statement naming two or more things, none of the thing\'s, is about something else', () => {
        expect(aboutThing('Signed up for a pottery class on Saturday mornings', GUITAR)).toBe('no');
        expect(aboutThing('Booked flights to Lisbon for the conference', 'Runs 5k on weekday mornings')).toBe('no');
    });
    it('one shared word is enough to be about it; too few words to tell leave the choice to the assistant', () => {
        expect(aboutThing('Played guitar for 25 minutes before lunch today', GUITAR)).toBe('yes');
        expect(aboutThing('Ran 5k this morning, legs felt heavy', 'Runs 5k on weekday mornings')).toBe('yes');
        expect(aboutThing('Done for today!', GUITAR)).toBe('unknown');
        expect(aboutThing('Got my steps in', 'Walking after work')).toBe('unknown');
    });
    it('cover: the share of the statement\'s topic the thing holds', () => {
        expect(topicCover('Swam 20 laps this morning', 'Swims at the local pool on Sundays')).toBe(0.5);
        expect(topicCover('Walked past the new gym today, thinking of joining', 'Walking after work')).toBeLessThan(0.5);
    });
});

describe('one day, a routine, or an end (fresh sentences)', () => {
    it('reads the shape of the words', () => {
        expect(shapeOf('Played guitar for 25 minutes before lunch today')).toMatchObject({ once: true, routine: false, ending: false, did: true });
        expect(shapeOf('I run in the evenings now, mornings are too rushed')).toMatchObject({ routine: true });
        expect(shapeOf('From today I practise before breakfast')).toMatchObject({ once: true, routine: true });
        expect(shapeOf("I've stopped the book-a-month thing, too busy")).toMatchObject({ ending: true });
        expect(shapeOf('Could not make it to the pool today')).toMatchObject({ once: true, skipped: true, did: false });
        expect(dayNewsOf('No practice today, the kids were sick')).toBe('skipped');
        expect(dayNewsOf('Ran 5k this morning')).toBe('done');
    });

    it('one day\'s doing is never a change or an end; a real change or end stands; the opposite day news takes the words\' side', () => {
        expect(updateFromWords('changed', 'Ran 5k this morning, legs felt heavy', true)).toBe('done');
        expect(updateFromWords('changed', 'I run in the evenings now, mornings are too rushed', true)).toBe('changed');
        expect(updateFromWords('changed', 'From today I practise before breakfast', true)).toBe('changed');
        expect(updateFromWords('dropped', 'Skipped my writing session today', false)).toBe('skipped');
        expect(updateFromWords('dropped', "I've stopped the book-a-month thing, too busy", false)).toBe('dropped');
        // A habit is not finished by one finished session; an aim may well be finished on a day.
        expect(updateFromWords('finished', 'Finished my practice session tonight, the scales are getting easier', true)).toBe('done');
        expect(updateFromWords('finished', 'Finished the first draft of the novel today', false)).toBe('finished');
        expect(updateFromWords('skipped', 'Got a good hour of practice in this evening', true)).toBe('done');
        expect(updateFromWords('done', 'Could not make it to the pool today', true)).toBe('skipped');
        // No cue either way: the assistant's choice stands.
        expect(updateFromWords('changed', 'Prefers tea to coffee', false)).toBe('changed');
        expect(updateFromWords('progress', 'Built the retriever for the prototype', false)).toBe('progress');
    });
});

// MCP_MEMORY_PLAN §12.4 B: what the three assistants really sent on 11-19 (the trace of the live test with fresh
// examples), each with the filing it should get, then pairs that must not link or mark. The planted things of that test:
const YOGA = 'Yoga before work, three mornings a week yoga mat asanas';
const READING = 'Reads 20 pages of a novel before bed';
const COFFEE = 'Cutting down to one coffee a day';
const RIDE = 'Training for a 50 km charity cycle ride in December';
const ALLERGY = 'Allergic to peanuts';
const PLANTED = [YOGA, READING, COFFEE, RIDE, ALLERGY];

describe('the 8 remember texts of 11-19 (§12.4 B1, B2)', () => {
    it('one day\'s news about one followed thing, without a doing word, is its progress', () => {
        // ChatGPT (twice) and claude.ai: the coffee slip. Whether a private one may link is the controller's rule.
        for (const text of [
            "Had two coffees today and says cutting down isn't going great.",
            "Had two coffees already today; cutting down isn't going great.",
            "Is trying to cut down on coffee; had two coffees already today and says it isn't going great",
        ]) {
            expect(PLANTED.map((thing) => dayNewsOn(text, thing))).toEqual([null, null, 'progress', null, null]);
        }
    });

    it('a change of a habit is never day news; it may replace the habit it shares two topic words with', () => {
        for (const text of ['Stopped reading before bed; now listens to audiobooks on the commute instead.']) {
            expect(PLANTED.map((thing) => dayNewsOn(text, thing))).toEqual([null, null, null, null, null]);
            expect(soundsLikeChange(text)).toBe(true);
            expect(PLANTED.map((thing) => topicOverlap(text, thing).shared >= 2)).toEqual([false, true, false, false, false]);
        }
    });

    it('a new interest links to nothing and replaces nothing', () => {
        for (const text of [
            'Has gotten into birdwatching; went to the lake on Sunday with binoculars.',
            'Has gotten into birdwatching lately; went to the lake on Sunday with binoculars.',
            'Has gotten into birdwatching lately; went to the lake with binoculars on Sunday (2026-11-15)',
        ]) {
            expect(PLANTED.map((thing) => dayNewsOn(text, thing))).toEqual([null, null, null, null, null]);
            expect(soundsLikeChange(text)).toBe(false);
        }
    });
});

describe('the 11 update_memory texts of 11-19 keep the kind they were sent with (all were filed right)', () => {
    it.each([
        ['progress', 'Did yoga this morning before logging on, for 40 minutes.', YOGA, true],
        ['changed', 'Stopped reading before bed; now listens to audiobooks on the commute instead.', READING, true],
        ['changed', 'From next week, moving yoga to the evenings because mornings are too rushed.', YOGA, true],
        ['done', 'Did yoga this morning before logging on, for 40 minutes.', YOGA, true],
        ['changed', "From next week I'm moving my yoga to the evenings; mornings are too rushed.", YOGA, true],
        ['done', 'Did yoga this morning before logging on, 40 minutes', YOGA, true],
        ['changed', 'Stopped reading before bed; listens to audiobooks on the commute instead', READING, true],
        ['progress', "Had two coffees already today, the cutting down isn't going great", COFFEE, false],
        ['dropped', "Pulled out of the charity ride in December, my knee can't take the training", RIDE, false],
        ['changed', 'From next week moving yoga to the evenings, mornings are too rushed', YOGA, true],
        ['changed', 'Allergic to cashews, not peanuts', ALLERGY, false],
    ] as const)('%s: %s', (update, text, thing, recurring) => {
        expect(aboutThing(text, thing)).not.toBe('no');
        expect(updateFromWords(update, text, recurring)).toBe(update);
    });
});

describe('must not link or mark (§12.4 B3)', () => {
    it('news that is not one day\'s doing of the thing stays new', () => {
        expect(dayNewsOn('Also allergic to shellfish', ALLERGY)).toBeNull();
        expect(dayNewsOn('Bought a rain cover for the charity ride', RIDE)).toBeNull();
        // A day named, two topic words shared, but less than half of either side's: not sure enough.
        expect(dayNewsOn('Bought a rain cover for the charity ride today', RIDE)).toBeNull();
        expect(dayNewsOn('Thinking about a coffee machine', COFFEE)).toBeNull();
        expect(dayNewsOn('Went to a coffee tasting today with my sister', COFFEE)).toBeNull();
        // One topic word only, no doing word: too little to tell (a safe miss: kept new for the buddy's AI).
        expect(dayNewsOn('Only one coffee today!', COFFEE)).toBeNull();
    });

    it('an addition, a purchase or a thought replaces nothing', () => {
        for (const text of ['Also allergic to shellfish', 'Bought a rain cover for the charity ride', 'Thinking about a coffee machine']) expect(soundsLikeChange(text)).toBe(false);
        // A correction said with "not" may replace what it names.
        expect(soundsLikeChange('Allergic to cashews, not peanuts')).toBe(true);
        expect(topicOverlap('Allergic to cashews, not peanuts', ALLERGY).shared).toBe(2);
    });

    it('the day news with a doing or a skip word works as before', () => {
        expect(dayNewsOn('Did yoga this morning before logging on, for 40 minutes.', YOGA)).toBe('done');
        expect(dayNewsOn('No yoga today, too tired', YOGA)).toBe('skipped');
        expect(dayNewsOn('Did yoga this morning', READING)).toBeNull();
    });
});

describe('a search word\'s root (§12.4 D: "allergies" finds "Allergic to cashews")', () => {
    it('cuts the ending so other forms of the word meet; short words stay as they are', () => {
        expect(searchRoot('allergies')).toBe('allerg');
        expect(searchRoot('allergy')).toBe('allerg');
        expect(searchRoot('reading')).toBe('read');
        expect(searchRoot('cycling')).toBe('cycl');
        expect(searchRoot('evenings')).toBe('evenin');
        expect(searchRoot('yoga')).toBeNull();
        expect(searchRoot('ride')).toBeNull();
    });
});
