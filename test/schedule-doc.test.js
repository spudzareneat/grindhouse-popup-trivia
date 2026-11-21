import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScheduleDoc, sameSchedule, publishSchedule, makeResolveItem, publishBestEffort, applyPick, SCHEDULE_FILE } from '../src/schedule-doc.js';

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

// publishSchedule: pull, fetch, build, compare with the file on disk, write, commit.
function pubEnv(over = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
    const calls = [];
    const git = { pull: () => calls.push(['pull']), push: () => calls.push(['push']), commitAndPush: (files, msg) => calls.push(['commit', files, msg]) };
    const run = (extra = {}) => publishSchedule({
        repoDir: dir, git, fetchPost: async () => post(), resolveItem: async () => 'tt1', rate: async () => ({ rating: 6, votes: 9 }),
        now: NOW, log: () => {}, ...over, ...extra,
    });
    return { dir, calls, run, file: path.join(dir, SCHEDULE_FILE) };
}
test('publishSchedule writes the file and commits it', async () => {
    const t = pubEnv();
    try {
        assert.equal(await t.run(), 'published');
        const written = JSON.parse(fs.readFileSync(t.file, 'utf8'));
        assert.equal(written.schema, 1);
        assert.equal(written.fetchedAt, NOW);
        assert.equal(items(written)[0].imdbId, 'tt1');
        assert.ok(fs.readFileSync(t.file, 'utf8').endsWith('}\n'));
        assert.deepEqual(t.calls, [['pull'], ['push'], ['commit', t.file, 'schedule: Weekend Grindhouse Schedule - Fri 11/20 - Sun 11/22']]);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
test('unchanged content is not rewritten or committed', async () => {
    const t = pubEnv();
    try {
        await t.run();
        const before = fs.readFileSync(t.file, 'utf8');
        assert.equal(await t.run({ now: '2026-11-20T05:00:00.000Z' }), 'unchanged');
        assert.equal(fs.readFileSync(t.file, 'utf8'), before);
        assert.equal(t.calls.filter(c => c[0] === 'commit').length, 1);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
test('changed content (a different resolved id) is republished, with a fresh rating', async () => {
    const t = pubEnv();
    try {
        await t.run();
        assert.equal(await t.run({ resolveItem: async () => 'tt2', rate: async () => ({ rating: 8, votes: 9 }) }), 'published');
        assert.equal(items(JSON.parse(fs.readFileSync(t.file, 'utf8')))[0].imdbRating, 8);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
test('a failing fetchPost leaves the existing file untouched and does not commit', async () => {
    const t = pubEnv();
    try {
        await t.run();
        const before = fs.readFileSync(t.file);
        await assert.rejects(t.run({ fetchPost: async () => { throw new Error('Reddit session expired'); } }), /session expired/);
        assert.deepEqual(fs.readFileSync(t.file), before);
        assert.equal(t.calls.filter(c => c[0] === 'commit').length, 1);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
test('a corrupt existing file is treated as missing and replaced', async () => {
    const t = pubEnv();
    try {
        fs.mkdirSync(path.dirname(t.file), { recursive: true });
        fs.writeFileSync(t.file, '{not json');
        assert.equal(await t.run(), 'published');
        assert.equal(JSON.parse(fs.readFileSync(t.file, 'utf8')).schema, 1);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// Wiring helpers used by the CLI.
function overridesFile(picks = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-'));
    const file = path.join(dir, 'title-overrides.json');
    fs.writeFileSync(file, JSON.stringify({ picks, dismissed: {} }));
    return { dir, file };
}
test('makeResolveItem honours an override, converting the string year to a number for the key', async () => {
    const o = overridesFile({ 'black cobra woman|1976': 'tt0074501' });
    try {
        const imdb = { searchTitle: async () => { throw new Error('must not search'); }, searchCandidates: async () => { throw new Error('must not search'); } };
        const resolveItem = makeResolveItem({ imdb, tmdb: null, overridesFile: o.file, log: () => {} });
        assert.equal(await resolveItem({ title: 'Black Cobra Woman', year: '1976', akas: [] }), 'tt0074501');
    } finally { fs.rmSync(o.dir, { recursive: true, force: true }); }
});
test('makeResolveItem searches IMDb with a numeric year, and returns null when nothing matches', async () => {
    const o = overridesFile();
    try {
        const seen = [];
        const imdb = {
            searchTitle: async (term, year) => { seen.push([term, year]); return term === 'Zeiram' ? { tconst: 'tt0103327', title: 'Zeiram', year: 1991, votes: 5000 } : null; },
            searchCandidates: async () => [],
        };
        const resolveItem = makeResolveItem({ imdb, tmdb: null, overridesFile: o.file, log: () => {} });
        assert.equal(await resolveItem({ title: 'Zeiram', year: '1991', akas: [] }), 'tt0103327');
        assert.deepEqual(seen[0], ['Zeiram', 1991]);
        assert.equal(await resolveItem({ title: 'Mystery Film', year: null, akas: [] }), null);
    } finally { fs.rmSync(o.dir, { recursive: true, force: true }); }
});
test('publishBestEffort skips when told to, and when there is no scraped post (manual lists)', async () => {
    let called = 0;
    const publish = async () => { called++; return 'published'; };
    assert.equal(await publishBestEffort({ skip: true, post: post(), publish, log: () => {} }), 'skipped');
    assert.equal(await publishBestEffort({ skip: false, post: undefined, publish, log: () => {} }), 'skipped');
    assert.equal(called, 0);
});
test('publishBestEffort hands the already-scraped post to publish and returns its result', async () => {
    let fetched;
    const result = await publishBestEffort({ skip: false, post: post(), publish: async fetchPost => { fetched = await fetchPost(); return 'unchanged'; }, log: () => {} });
    assert.equal(result, 'unchanged');
    assert.deepEqual(fetched, post());
});
test('publishBestEffort never throws: a publish failure is logged and reported as failed', async () => {
    const logs = [];
    const result = await publishBestEffort({ skip: false, post: post(), publish: async () => { throw new Error('git push failed'); }, log: m => logs.push(m) });
    assert.equal(result, 'failed');
    assert.ok(logs.some(l => l.includes('git push failed') && /run continues/.test(l)));
});

// applyPick: a Discord pick (or dismiss) updates the matching published item.
async function docFor() {
    return buildScheduleDoc({ post: post(), now: NOW, resolveItem: async item => 'tt-' + item.title.replace(/ /g, ''), rate: async () => ({ rating: 5, votes: 10 }) });
}
test('applyPick sets id, rating and votes on the matching item only', async () => {
    const doc = await docFor();
    const before = structuredClone(doc);
    const { doc: next, changed } = applyPick(doc, { title: 'Tenebre', year: 1984, tconst: 'tt0084777', rating: { rating: 7.6, votes: 21000 } });
    assert.equal(changed, true);
    assert.deepEqual(doc, before);
    const [zeiram, , tenebre] = items(next);
    assert.deepEqual([tenebre.imdbId, tenebre.imdbRating, tenebre.imdbVotes], ['tt0084777', 7.6, 21000]);
    assert.equal(zeiram.imdbId, 'tt-Zeiram');
});
test('applyPick on dismiss nulls the id, rating and votes', async () => {
    const { doc: next, changed } = applyPick(await docFor(), { title: 'Zeiram', year: 1991, tconst: null, rating: null });
    assert.equal(changed, true);
    assert.deepEqual([items(next)[0].imdbId, items(next)[0].imdbRating, items(next)[0].imdbVotes], [null, null, null]);
});
test('applyPick for a film not in the file, or with identical values, reports changed false', async () => {
    const doc = await docFor();
    assert.equal(applyPick(doc, { title: 'Not On The Schedule', year: 2001, tconst: 'tt1', rating: null }).changed, false);
    assert.equal(applyPick(doc, { title: 'Zeiram', year: 1991, tconst: 'tt-Zeiram', rating: { rating: 5, votes: 10 } }).changed, false);
});
test('applyPick matches the string year in the file against the numeric pick year, and yearless items by null', async () => {
    const doc = await docFor();
    assert.equal(applyPick(doc, { title: 'zeiram', year: 1991, tconst: 'tt9', rating: null }).changed, true);
    assert.equal(applyPick(doc, { title: 'Zeiram', year: 1992, tconst: 'tt9', rating: null }).changed, false);
    assert.equal(applyPick(doc, { title: 'Mystery Film', year: null, tconst: 'tt9', rating: null }).changed, true);
});

// --- Final-review fixes ---
test('makeResolveItem returns null for a dismissed title without searching (a dismiss must not be re-resolved)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dis-'));
    const file = path.join(dir, 'title-overrides.json');
    fs.writeFileSync(file, JSON.stringify({ picks: {}, dismissed: { 'seven|1979': true } }));
    try {
        const imdb = { searchTitle: async () => { throw new Error('must not search'); }, searchCandidates: async () => { throw new Error('must not search'); } };
        const resolveItem = makeResolveItem({ imdb, tmdb: null, overridesFile: file, log: () => {} });
        assert.equal(await resolveItem({ title: 'Seven', year: '1979', akas: [] }), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const prevDoc = async (over = {}) => {
    const d = await buildScheduleDoc({ post: post(), now: NOW, resolveItem: async item => 'tt-' + item.title.replace(/ /g, ''), rate: async () => ({ rating: 6.4, votes: 3100 }) });
    return { ...d, ...over };
};
test('a failed or empty lookup carries forward the previously published id (same post only)', async () => {
    const previous = await prevDoc();
    const nulls = await buildScheduleDoc({ post: post(), now: NOW, previous, resolveItem: async () => null, rate: async () => null });
    assert.deepEqual(items(nulls).map(i => i.imdbId), items(previous).map(i => i.imdbId));
    const threw = await buildScheduleDoc({ post: post(), now: NOW, previous, resolveItem: async () => { throw new Error('imdb down'); }, rate: async () => null });
    assert.deepEqual(items(threw).map(i => i.imdbId), items(previous).map(i => i.imdbId));
    const otherPost = await buildScheduleDoc({ post: { ...post(), postId: 't3_other' }, now: NOW, previous, resolveItem: async () => null, rate: async () => null });
    assert.ok(items(otherPost).every(i => i.imdbId === null));
});
test('a previously published rating is kept, not refetched, while the id is unchanged (no vote-count churn)', async () => {
    const previous = await prevDoc();
    let rated = 0;
    const next = await buildScheduleDoc({ post: post(), now: NOW, previous, resolveItem: async item => 'tt-' + item.title.replace(/ /g, ''), rate: async () => { rated++; return { rating: 9.9, votes: 99999 }; } });
    assert.equal(rated, 0);
    assert.deepEqual(items(next).map(i => [i.imdbRating, i.imdbVotes]), items(previous).map(i => [i.imdbRating, i.imdbVotes]));
});
test('a missing rating is fetched, and a changed id gets a fresh rating', async () => {
    const previous = await prevDoc();
    items(previous)[0].imdbRating = null; items(previous)[0].imdbVotes = null;
    const refreshed = await buildScheduleDoc({ post: post(), now: NOW, previous, resolveItem: async item => 'tt-' + item.title.replace(/ /g, ''), rate: async () => ({ rating: 8, votes: 5 }) });
    assert.deepEqual([items(refreshed)[0].imdbRating, items(refreshed)[1].imdbRating], [8, 6.4]);
    const changedId = await buildScheduleDoc({ post: post(), now: NOW, previous: await prevDoc(), resolveItem: async () => 'tt-NEW', rate: async () => ({ rating: 7, votes: 1 }) });
    assert.ok(items(changedId).every(i => i.imdbId === 'tt-NEW' && i.imdbRating === 7));
});
test('publishSchedule: an IMDb outage or vote drift after a good publish changes nothing and commits nothing', async () => {
    const t = pubEnv();
    try {
        await t.run({ rate: async () => ({ rating: 6, votes: 9 }) });
        const before = fs.readFileSync(t.file, 'utf8');
        assert.equal(await t.run({ now: '2026-11-20T05:00:00.000Z', resolveItem: async () => null, rate: async () => { throw new Error('down'); } }), 'unchanged');
        assert.equal(await t.run({ now: '2026-11-20T06:00:00.000Z', rate: async () => ({ rating: 6.1, votes: 12 }) }), 'unchanged');
        assert.equal(fs.readFileSync(t.file, 'utf8'), before);
        assert.equal(t.calls.filter(c => c[0] === 'commit').length, 1);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
test('publishSchedule delivers commits stranded by an earlier failed push: pull, then push, before anything else', async () => {
    const t = pubEnv();
    try {
        await t.run();
        t.calls.length = 0;
        assert.equal(await t.run(), 'unchanged');
        assert.deepEqual(t.calls, [['pull'], ['push']]);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// --- Published info (per-film `info` object) ---
const idOf = item => 'tt-' + item.title.replace(/ /g, '');
const infoOf = id => ({ imdbId: id, cleanTitle: 'Title ' + id, poster: 'https://p/' + id });
const buildWith = (over = {}) => buildScheduleDoc({ post: post(), now: NOW, resolveItem: async item => idOf(item), rate: async () => ({ rating: 5, votes: 10 }), fetchInfo: async id => infoOf(id), ...over });

test('items gain info when fetchInfo is supplied, and have no info key otherwise', async () => {
    const withInfo = await buildWith();
    assert.deepEqual(items(withInfo).map(i => i.info), items(withInfo).map(i => infoOf(i.imdbId)));
    const without = await buildWith({ fetchInfo: undefined });
    assert.ok(items(without).every(i => !('info' in i)));
});
test('an unresolved item has info null and fetchInfo is not called for it', async () => {
    const asked = [];
    const doc = await buildWith({ resolveItem: async item => (item.title === 'Mystery Film' ? null : idOf(item)), fetchInfo: async id => { asked.push(id); return infoOf(id); } });
    assert.equal(items(doc)[1].info, null);
    assert.ok(!asked.includes(null));
    assert.equal(asked.length, 2);
});
test('complete previous info for the same post and id is kept and not refetched', async () => {
    const previous = await buildWith();
    items(previous)[0].info = { ...items(previous)[0].info, poster: 'https://old/poster' };
    let calls = 0;
    const next = await buildWith({ previous, fetchInfo: async id => { calls++; return infoOf(id); } });
    assert.equal(calls, 0);
    assert.equal(items(next)[0].info.poster, 'https://old/poster');
});
test('incomplete previous info (no cleanTitle) is refetched; a failed refetch keeps the incomplete previous info', async () => {
    const previous = await buildWith();
    items(previous)[0].info = { imdbId: items(previous)[0].imdbId };
    const refreshed = await buildWith({ previous });
    assert.equal(items(refreshed)[0].info.cleanTitle, 'Title ' + items(previous)[0].imdbId);
    const kept = await buildWith({ previous, fetchInfo: async () => { throw new Error('down'); } });
    assert.deepEqual(items(kept)[0].info, { imdbId: items(previous)[0].imdbId });
    const keptNull = await buildWith({ previous, fetchInfo: async () => null });
    assert.deepEqual(items(keptNull)[0].info, { imdbId: items(previous)[0].imdbId });
});
test('a changed id refetches and never keeps the old film\'s info; a different post never reuses previous info', async () => {
    const previous = await buildWith();
    const changed = await buildWith({ previous, resolveItem: async () => 'tt-NEW' });
    assert.ok(items(changed).every(i => i.info.imdbId === 'tt-NEW'));
    const failed = await buildWith({ previous, resolveItem: async () => 'tt-NEW', fetchInfo: async () => { throw new Error('down'); } });
    assert.ok(items(failed).every(i => i.info === null));
    const otherPost = await buildScheduleDoc({ post: { ...post(), postId: 't3_other' }, now: NOW, previous, resolveItem: async item => idOf(item), rate: async () => ({ rating: 1, votes: 1 }), fetchInfo: async id => ({ ...infoOf(id), poster: 'fresh' }) });
    assert.ok(items(otherPost).every(i => i.info.poster === 'fresh'));
});
test('publishSchedule: a second run with a failing fetchInfo changes nothing and commits nothing', async () => {
    const t = pubEnv();
    try {
        await t.run({ fetchInfo: async id => infoOf(id) });
        const before = fs.readFileSync(t.file, 'utf8');
        assert.equal(await t.run({ now: '2026-11-21T05:00:00.000Z', fetchInfo: async () => { throw new Error('down'); } }), 'unchanged');
        assert.equal(fs.readFileSync(t.file, 'utf8'), before);
        assert.equal(t.calls.filter(c => c[0] === 'commit').length, 1);
        assert.ok(items(JSON.parse(before)).every(i => i.info && i.info.cleanTitle));
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
test('publishSchedule republishes when info was missing and is now available (retry of an earlier failure)', async () => {
    const t = pubEnv();
    try {
        await t.run({ fetchInfo: async () => null });
        assert.ok(items(JSON.parse(fs.readFileSync(t.file, 'utf8'))).every(i => i.info === null));
        assert.equal(await t.run({ now: '2026-11-21T06:00:00.000Z', fetchInfo: async id => infoOf(id) }), 'published');
        assert.ok(items(JSON.parse(fs.readFileSync(t.file, 'utf8'))).every(i => i.info && i.info.cleanTitle));
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// applyPick with info: a Discord pick refreshes the picked film's published info too.
test('applyPick sets info on the matching item only, and reports changed', async () => {
    const doc = await docFor();
    const info = { imdbId: 'tt0084777', cleanTitle: 'Tenebrae', poster: 'https://p/t' };
    const { doc: next, changed } = applyPick(doc, { title: 'Tenebre', year: 1984, tconst: 'tt0084777', rating: null, info });
    assert.equal(changed, true);
    assert.deepEqual(items(next)[2].info, info);
    assert.ok(!('info' in items(next)[0]));
    assert.ok(!('info' in items(doc)[2]));
});
test('applyPick with info undefined leaves info untouched, and with null clears it', async () => {
    const doc = await docFor();
    items(doc)[2].info = { imdbId: 'tt-Tenebre', cleanTitle: 'Old' };
    const keep = applyPick(doc, { title: 'Tenebre', year: 1984, tconst: 'tt-Tenebre', rating: { rating: 5, votes: 10 } });
    assert.equal(keep.changed, false);
    assert.equal(items(keep.doc)[2].info.cleanTitle, 'Old');
    const cleared = applyPick(doc, { title: 'Tenebre', year: 1984, tconst: null, rating: null, info: null });
    assert.equal(cleared.changed, true);
    assert.deepEqual([items(cleared.doc)[2].imdbId, items(cleared.doc)[2].info], [null, null]);
});
test('applyPick reports changed false when the info is identical', async () => {
    const doc = await docFor();
    const info = { imdbId: 'tt-Zeiram', cleanTitle: 'Zeiram' };
    items(doc)[0].info = info;
    assert.equal(applyPick(doc, { title: 'Zeiram', year: 1991, tconst: 'tt-Zeiram', rating: { rating: 5, votes: 10 }, info: { ...info } }).changed, false);
});
