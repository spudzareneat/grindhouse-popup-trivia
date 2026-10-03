import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntries, selectCurrentEntry, parseSchedule, flattenMovies, fetchWeekendMovies, parseDateRange } from '../src/schedule.js';

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
