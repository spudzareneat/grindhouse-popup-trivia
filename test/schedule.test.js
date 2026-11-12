import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntries, selectCurrentEntry, parseSchedule, parseListItems, flattenMovies, fetchWeekendMovies, readWeekendMoviesFile, feedUrl, FEED_URL, parseDateRange } from '../src/schedule.js';

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const entry = (id, title, pub, html) =>
    `<entry><id>${id}</id><title>${esc(title)}</title><published>${pub}</published><content type="html">${esc(html)}</content></entry>`;
const BODY = '<p>Intro</p>' +
    '<p><strong>Friday</strong></p><p><strong>Creature Feature</strong></p>' +
    '<ul><li>Carnival of Souls (1962)</li><li>Alligator (1980) aka Alligator: The Bite</li></ul>' +
    '<p><strong>==Saturday==</strong></p><p><strong>Late Show</strong></p>' +
    '<ul><li>Don&#39;t Look in the Basement (1973)</li><li>Decampitated (1998))</li><li>Mystery Film</li><li>Carnival of Souls (1962)</li></ul>';
const FEED = '<?xml version="1.0"?><feed>' +
    entry('t3_old', 'Weekend Grindhouse Schedule - Fri 9/26 - Sun 9/28', '2026-09-22T12:00:00+00:00', '<p>old</p>') +
    entry('t3_new', 'Weekend Grindhouse Schedule - Fri 10/3 - Sun 10/5', '2026-09-30T12:00:00+00:00', BODY) +
    entry('t3_x', 'Random post', '2026-10-01T00:00:00+00:00', '<p>hi</p>') +
    '</feed>';

test('parseEntries extracts and entity-decodes all entries', () => {
    const e = parseEntries(FEED);
    assert.equal(e.length, 3);
    assert.match(e[1].contentHtml, /Don't Look in the Basement/);
});
test('selectCurrentEntry picks the newest schedule-titled post', () => {
    assert.equal(selectCurrentEntry(parseEntries(FEED)).postId, 't3_new');
});
test('parseDateRange reads Friday and derives the weekend', () => {
    assert.deepEqual(parseDateRange('Schedule - Fri 10/3 - Sun 10/5', '2026-09-30T12:00:00+00:00'),
        { fri: '2026-10-03', sat: '2026-10-04', sun: '2026-10-05' });
    assert.equal(parseDateRange('Random post', '2026-09-30T12:00:00+00:00'), null);
});
test('parseSchedule + flattenMovies: days, akas, typo paren, yearless, dedupe', () => {
    const movies = flattenMovies(parseSchedule(selectCurrentEntry(parseEntries(FEED)).contentHtml));
    assert.deepEqual(movies.map(m => [m.title, m.year, m.day]), [
        ['Carnival of Souls', 1962, 'Friday'],
        ['Alligator', 1980, 'Friday'],
        ["Don't Look in the Basement", 1973, 'Saturday'],
        ['Decampitated', 1998, 'Saturday'],
        ['Mystery Film', null, 'Saturday'],
    ]);
    assert.deepEqual(movies[1].akas, ['Alligator: The Bite']);
    assert.ok(movies.every(m => Number.isInteger(m.block)));
});
test('flattenMovies: block is the section index within its night; a repeat keeps the earliest', () => {
    const it = title => ({ title, year: '1980', akas: [] });
    const movies = flattenMovies([
        { day: 'Friday', sections: [{ name: 'A', items: [it('One')] }, { name: 'B', items: [it('Two')] }, { name: 'C', items: [it('Three')] }] },
        { day: 'Saturday', sections: [{ name: 'D', items: [it('Three')] }] },
    ]);
    assert.deepEqual(movies.map(m => [m.title, m.block]), [['One', 0], ['Two', 1], ['Three', 0]]);
});
test('fetchWeekendMovies uses a browser UA and returns post title + movies', async () => {
    let seenUa = null;
    const fetchImpl = async (url, opts) => { seenUa = opts.headers['User-Agent']; return { ok: true, status: 200, text: async () => FEED }; };
    const r = await fetchWeekendMovies(fetchImpl);
    assert.match(seenUa, /Mozilla/);
    assert.equal(r.postTitle, 'Weekend Grindhouse Schedule - Fri 10/3 - Sun 10/5');
    assert.equal(r.movies.length, 5);
    assert.equal(r.weekendFri, '2026-10-03');
});
test('fetchWeekendMovies throws on HTTP error and on no schedule post', async () => {
    await assert.rejects(fetchWeekendMovies(async () => ({ ok: false, status: 403, text: async () => '' })), /HTTP 403/);
    await assert.rejects(fetchWeekendMovies(async () => ({ ok: true, status: 200, text: async () => '<feed></feed>' })), /no schedule post/);
});

// Ported from the userscript's scripts/test-lineup-parse-schedule.mjs (commit ddaabe4).
const shape = days => days.map(d => ({ day: d.day, sections: d.sections.map(s => `${s.name}:${s.items.map(i => i.title).join('|')}`) }));
test('parseSchedule: plain and ==decorated== day headers', () => {
    assert.deepEqual(shape(parseSchedule(
        '<p><strong>Playing this weekend @</strong> x</p>' +
        '<p><strong>Friday</strong></p><p><strong>Funky Cheese Friday</strong></p><ul><li>A (1990)</li></ul>' +
        '<p><strong>Saturday</strong></p><p><strong>Psychedelic Saturday</strong></p><ul><li>B (1991)</li></ul>')),
        [{ day: 'Friday', sections: ['Funky Cheese Friday:A'] }, { day: 'Saturday', sections: ['Psychedelic Saturday:B'] }]);
    assert.deepEqual(shape(parseSchedule(
        '<p><strong>==Friday==</strong></p><p><strong>Friday Night Freak Show</strong></p><ul><li>A (1990)</li></ul>')),
        [{ day: 'Friday', sections: ['Friday Night Freak Show:A'] }]);
});
test('parseSchedule: themed day headers + nested-tag section header (Halloween 2026-10-30)', () => {
    assert.deepEqual(shape(parseSchedule(
        '<p><strong>Playing this weekend @</strong> <a href="x">420Grindhouse</a>.</p> <p><em>Showtime starts each day @ 3pm EST/12pm PST.</em></p> ' +
        '<p><strong>==Halloween Eve Friday==</strong></p> <p><strong>Funky Cheese Friday</strong></p> <ul> <li>Ernest Scared Stupid (1991)</li> </ul> ' +
        '<p><strong>==Halloween Saturday==</strong></p> <p><strong>Saturday Prime Time Drive-In</strong></p> <ul> <li>The Exorcist (1973)</li> </ul> ' +
        '<p>**<strong><em>Halloween Raffle Winners Reveal</em></strong>**</p> <ul> <li>The Beyond (1981)</li> </ul> ' +
        '<p><strong>==Halloween Hangover Sunday==</strong></p> <p><strong>The Sunday Classics</strong></p> <ul> <li>Blood Feast (1963)</li> </ul>')),
        [
            { day: 'Friday', sections: ['Funky Cheese Friday:Ernest Scared Stupid'] },
            { day: 'Saturday', sections: ['Saturday Prime Time Drive-In:The Exorcist', 'Halloween Raffle Winners Reveal:The Beyond'] },
            { day: 'Sunday', sections: ['The Sunday Classics:Blood Feast'] },
        ]);
});

test('parseListItems: year typos, double-encoded entities, unbracketed numbers stay in titles', () => {
    const items = parseListItems(['Jason X )2001)', 'Family Reunion [2003]', 'A Wrestling Christmas Miracle (2020',
        'Fit to Kill 1993)', 'Judge &amp; Jury (1996)', 'Equalizer 2000 (1987)', 'Class of 1984 (1982)',
        'The Chosen (1977) aka Holocaust 2000', 'Bloodstone: Subspecies II'].map(t => `<li>${t}</li>`).join(''));
    assert.deepEqual(items.map(i => [i.title, i.year]), [
        ['Jason X', '2001'], ['Family Reunion', '2003'], ['A Wrestling Christmas Miracle', '2020'],
        ['Fit to Kill', '1993'], ['Judge & Jury', '1996'], ['Equalizer 2000', '1987'], ['Class of 1984', '1982'],
        ['The Chosen', '1977'], ['Bloodstone: Subspecies II', null],
    ]);
    assert.deepEqual(items[7].akas, ['Holocaust 2000']);
});
test('parseSchedule keeps lists with no section header instead of dropping them', () => {
    assert.deepEqual(shape(parseSchedule(
        '<ul><li><a href="x">a link</a></li></ul>' +
        '<p><strong>Friday</strong></p><ul><li>A (1990)</li></ul><p><strong>Late</strong></p><ul><li>B (1991)</li></ul>')),
        [{ day: 'Friday', sections: ['Friday:A', 'Late:B'] }]);
    assert.deepEqual(shape(parseSchedule('<p>This weekend:</p><ul><li>A (1990)</li><li>See you there</li></ul>')),
        [{ day: 'Unknown', sections: ['Unknown:A'] }]);
});
test('selectCurrentEntry looks past the first five feed entries', () => {
    const filler = Array.from({ length: 6 }, (_, i) => entry(`t3_f${i}`, `Chat ${i}`, '2026-10-01T00:00:00+00:00', '<p>x</p>')).join('');
    const feed = `<feed>${filler}${entry('t3_s', 'Weekend Grindhouse Schedule - Fri 10/3 - Sun 10/5', '2026-09-30T12:00:00+00:00', BODY)}</feed>`;
    assert.equal(selectCurrentEntry(parseEntries(feed)).postId, 't3_s');
});

test('fetchWeekendMovies retries a 429 (honouring the hint) but never a 403', async () => {
    const waits = [];
    let calls = 0;
    const flaky = async () => ++calls < 3
        ? { ok: false, status: 429, headers: { 'x-ratelimit-reset': '8' }, text: async () => '' }
        : { ok: true, status: 200, text: async () => FEED };
    const r = await fetchWeekendMovies(flaky, { sleep: async ms => waits.push(ms) });
    assert.equal(r.movies.length, 5);
    assert.deepEqual(waits, [8000, 8000]);
    let blocked = 0;
    await assert.rejects(fetchWeekendMovies(async () => { blocked++; return { ok: false, status: 403, text: async () => '' }; }, { sleep: async () => {} }), /HTTP 403/);
    assert.equal(blocked, 1);
    let limited = 0;
    await assert.rejects(fetchWeekendMovies(async () => { limited++; return { ok: false, status: 429, text: async () => '' }; }, { sleep: async () => {} }), /HTTP 429/);
    assert.equal(limited, 4);
});
test('readWeekendMoviesFile parses a saved feed', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const f = join(mkdtempSync(join(tmpdir(), 'sched-')), 'feed.xml');
    writeFileSync(f, FEED);
    const r = readWeekendMoviesFile(f);
    assert.equal(r.postTitle, 'Weekend Grindhouse Schedule - Fri 10/3 - Sun 10/5');
    assert.equal(r.movies.length, 5);
});

test('feedUrl applies a personal feed token to the subreddit feed, and defaults to the public one', () => {
    assert.equal(feedUrl({}), FEED_URL);
    assert.equal(feedUrl({ REDDIT_FEED_URL: 'https://www.reddit.com/.rss?feed=abc123&user=someone' }), FEED_URL + '?feed=abc123&user=someone');
});
test('a non-429 failure reports the readable part of the error page, never the URL', async () => {
    const page = '<style>.x{color:red}</style><body><h1>blocked by network security</h1></body>';
    await assert.rejects(fetchWeekendMovies(async () => ({ ok: false, status: 403, text: async () => page })), err => /HTTP 403 — blocked by network security/.test(err.message) && !/feed=/.test(err.message));
});
