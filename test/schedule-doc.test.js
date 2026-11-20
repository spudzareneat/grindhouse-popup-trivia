import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleDoc, sameSchedule, SCHEDULE_FILE } from '../src/schedule-doc.js';

const post = () => ({
    postId: 't3_new', title: 'Weekend Grindhouse Schedule - Fri 11/20 - Sun 11/22', publishedAt: '2026-11-18T12:00:00+00:00',
    weekend: { fri: '2026-11-20', sat: '2026-11-21', sun: '2026-11-22' },
    days: [
        { day: 'Friday', date: '2026-11-20', sections: [{ name: 'Friday', slug: 'friday', items: [
            { title: 'Zeiram', year: '1991', display: 'Zeiram (1991)', akas: [] },
            { title: 'Mystery Film', year: null, display: 'Mystery Film', akas: [] },
        ] }] },
        { day: 'Saturday', date: '2026-11-21', sections: [{ name: 'Late Show', slug: 'late-show', items: [
            { title: 'Tenebre', year: '1984', display: 'Tenebre (1984)', akas: ['Tenebrae'] },
        ] }] },
    ],
});
const NOW = '2026-11-19T17:00:00.000Z';
const items = doc => doc.days.flatMap(d => d.sections.flatMap(s => s.items));

test('SCHEDULE_FILE is schedule/current.json', () => {
    assert.equal(SCHEDULE_FILE, 'schedule/current.json');
});
test('buildScheduleDoc fills id, rating and votes per item', async () => {
    const ids = { Zeiram: 'tt0103327', 'Mystery Film': 'tt9', Tenebre: 'tt0084777' };
    const doc = await buildScheduleDoc({
        post: post(), now: NOW,
        resolveItem: async item => ids[item.title],
        rate: async id => ({ rating: id === 'tt0103327' ? 6.4 : 7.5, votes: 3100 }),
    });
    assert.equal(doc.schema, 1);
    assert.equal(doc.fetchedAt, NOW);
    assert.equal(doc.postId, 't3_new');
    assert.equal(doc.title, 'Weekend Grindhouse Schedule - Fri 11/20 - Sun 11/22');
    assert.equal(doc.publishedAt, '2026-11-18T12:00:00+00:00');
    assert.deepEqual(doc.weekend, { fri: '2026-11-20', sat: '2026-11-21', sun: '2026-11-22' });
    assert.deepEqual(doc.days.map(d => [d.day, d.date, d.sections.map(s => s.slug)]), [['Friday', '2026-11-20', ['friday']], ['Saturday', '2026-11-21', ['late-show']]]);
    assert.deepEqual(items(doc)[0], { title: 'Zeiram', year: '1991', display: 'Zeiram (1991)', akas: [], imdbId: 'tt0103327', imdbRating: 6.4, imdbVotes: 3100 });
    assert.equal(typeof items(doc)[0].year, 'string');
    assert.equal(items(doc)[2].imdbId, 'tt0084777');
});
test('an unresolved title keeps null id/rating/votes and is not rated', async () => {
    const rated = [];
    const doc = await buildScheduleDoc({ post: post(), now: NOW, resolveItem: async item => item.title === 'Zeiram' ? 'tt1' : null, rate: async id => { rated.push(id); return { rating: 5, votes: 1 }; } });
    assert.deepEqual(rated, ['tt1']);
    assert.deepEqual(items(doc)[1], { title: 'Mystery Film', year: null, display: 'Mystery Film', akas: [], imdbId: null, imdbRating: null, imdbVotes: null });
    assert.equal(items(doc)[0].imdbRating, 5);
});
test('a throwing resolver or rater yields nulls and does not abort', async () => {
    const doc = await buildScheduleDoc({
        post: post(), now: NOW,
        resolveItem: async item => { if (item.title === 'Zeiram') throw new Error('imdb down'); return 'tt' + item.title.length; },
        rate: async id => { if (id === 'tt12') throw new Error('rate down'); return { rating: 7, votes: 10 }; },
    });
    const [zeiram, mystery, tenebre] = items(doc);
    assert.deepEqual([zeiram.imdbId, zeiram.imdbRating], [null, null]);
    assert.deepEqual([mystery.imdbId, mystery.imdbRating, mystery.imdbVotes], ['tt12', null, null]);
    assert.deepEqual([tenebre.imdbId, tenebre.imdbRating], ['tt7', 7]);
});
test('a null rating (title has none) leaves rating and votes null', async () => {
    const doc = await buildScheduleDoc({ post: post(), now: NOW, resolveItem: async () => 'tt1', rate: async () => null });
    assert.ok(items(doc).every(i => i.imdbId === 'tt1' && i.imdbRating === null && i.imdbVotes === null));
});
test('buildScheduleDoc does not mutate the post', async () => {
    const p = post();
    await buildScheduleDoc({ post: p, now: NOW, resolveItem: async () => 'tt1', rate: async () => ({ rating: 1, votes: 1 }) });
    assert.deepEqual(p, post());
});
test('sameSchedule ignores fetchedAt but not content', async () => {
    const mk = now => buildScheduleDoc({ post: post(), now, resolveItem: async () => 'tt1', rate: async () => ({ rating: 6, votes: 9 }) });
    const a = await mk(NOW), b = await mk('2026-11-20T05:00:00.000Z');
    assert.equal(sameSchedule(a, b), true);
    const c = structuredClone(b);
    c.days[0].sections[0].items[0].imdbId = 'tt2';
    assert.equal(sameSchedule(a, c), false);
    assert.equal(sameSchedule(null, a), false);
    assert.equal(sameSchedule(a, undefined), false);
});
