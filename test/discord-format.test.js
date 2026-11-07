import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, buildPicker, needsPicker, parsePickId } from '../src/discord/format.js';

const m = (o = {}) => ({ scheduleTitle: 'S', scheduleYear: 1999, source: 'imdb', confidence: 'confident', matchedTitle: 'Heat', matchedYear: 1995, candidates: [], ...o });
const done = (title, o = {}) => ({ status: 'done', title, kept: 12, match: m({ matchedTitle: title }), ...o });
const desc = (r, o = { postTitle: null }) => buildSummary(r, o).embeds[0].description;

test('all-done run has no Needs a look section', () => {
    const d = desc([done('Heat'), done('Alien')]);
    assert.ok(!d.includes('Needs a look'));
    assert.ok(d.includes('Done'));
    assert.ok(d.includes('Heat'));
});

test('failures and unsure matches come before done movies', () => {
    const d = desc([
        done('Heat'),
        { status: 'failed', title: 'Zed', reason: 'boom', match: m() },
        { status: 'done', title: 'Maybe', kept: 3, match: m({ confidence: 'unsure', matchedTitle: 'Maybe' }) },
    ]);
    assert.ok(d.indexOf('Needs a look') < d.indexOf('Done'));
    assert.ok(d.indexOf('Zed') < d.indexOf('Heat'));
    assert.ok(d.indexOf('Maybe') < d.indexOf('Heat'));
});

test('tmdb match carries the marker; imdb does not', () => {
    const t = desc([{ ...done('Heat'), match: m({ source: 'tmdb' }) }]);
    assert.ok(t.includes('via TMDB'));
    assert.ok(!desc([done('Heat')]).includes('via TMDB'));
});

test('skipped section and stop note, tolerating results without match', () => {
    const d = desc([
        { status: 'skipped', title: 'Old', reason: 'already done' },
        { status: 'failed', title: 'X', stop: 'usage', reason: 'usage limit' },
        { status: 'failed', title: 'Y', stop: 'publish', reason: 'git push failed' },
    ]);
    assert.ok(d.includes('Skipped'));
    assert.ok(d.indexOf('Skipped') < d.toLowerCase().lastIndexOf('run stopped'));
    assert.ok(d.includes('Needs a look'));
});

test('postTitle becomes the embed title', () => {
    assert.equal(buildSummary([], { postTitle: 'Week 5' }).embeds[0].title.includes('Week 5'), true);
});

test('long run is truncated to 4000 chars ending in ...and N more, keeping Needs a look', () => {
    const long = 'x'.repeat(400);
    const results = [{ status: 'failed', title: 'Broken', reason: 'bad', match: m() }];
    for (let i = 0; i < 14; i++) results.push({ status: 'skipped', title: `Movie ${i}`, reason: long });
    const d = desc(results);
    assert.ok(d.length <= 4000);
    assert.match(d, /\.\.\.and \d+ more$/);
    assert.ok(d.includes('Needs a look'));
    assert.ok(d.includes('Broken'));
});

test('15 failures with 400-char reasons: fits, all titles kept, no lone "...and more"', () => {
    const long = 'y'.repeat(400);
    const results = [];
    for (let i = 0; i < 15; i++) results.push({ status: 'failed', title: `Fail${i}x`, reason: long, match: m() });
    const d = desc(results);
    assert.ok(d.length <= 4000);
    for (let i = 0; i < 15; i++) assert.ok(d.includes(`Fail${i}x`), `missing Fail${i}x`);
    assert.ok(!d.includes('...and more'));
});

test('60 failures: fits, whole lines dropped, stop note kept, N matches dropped lines', () => {
    const results = [];
    for (let i = 0; i < 60; i++) results.push({ status: 'failed', title: `Fail${i}x`, reason: 'z'.repeat(400), match: m() });
    results.push({ status: 'failed', title: 'Stopper', stop: 'usage', reason: 'usage limit' });
    const d = desc(results);
    assert.ok(d.length <= 4000);
    assert.ok(d.includes('Run stopped'));
    const n = Number(/\.\.\.and (\d+) more/.exec(d)[1]);
    assert.ok(n > 0);
    const lines = d.split('\n').filter((l) => l.startsWith('• '));
    assert.equal(lines.length + n, 61);
    assert.ok(lines.every((l) => /^• \*\*[^*]+\*\*: /.test(l)));
});

test('clip does not split surrogate pairs; missing source omitted from label', () => {
    const results = [{ status: 'failed', title: '😀'.repeat(200), reason: '😀'.repeat(400), match: m() }];
    assert.ok(desc(results).isWellFormed());
    const e = entry(1);
    delete e.candidates[0].source;
    assert.ok(!buildPicker(e).components[0].components[0].label.includes('undefined'));
});

const entry = (n, guess = null) => ({
    id: 'e1', scheduleTitle: 'S', scheduleYear: 1999, guessTconst: guess,
    candidates: Array.from({ length: n }, (_, i) => ({ tconst: `tt${i}`, title: `T${i}`, year: 2000 + i, votes: 1, source: i % 2 ? 'tmdb' : 'imdb' })),
});

test('buildPicker caps at 5 candidates plus None of these, spread over rows of at most 5 buttons', () => {
    const p = buildPicker(entry(8, 'tt1'));
    const buttons = p.components.flatMap((row) => row.components);
    assert.equal(buttons.length, 6);
    assert.ok(p.components.every((row) => row.type === 1));
    assert.ok(buttons.every((b) => b.type === 2 && b.custom_id.length < 100 && b.label.length <= 80));
    assert.equal(buttons[0].custom_id, 'pick:e1:tt0');
    assert.ok(buttons[1].label.startsWith('✓ '));
    assert.ok(!buttons[0].label.startsWith('✓'));
    const none = buttons.at(-1);
    assert.equal(none.custom_id, 'pick:e1:none');
    assert.equal(none.style, 2);
    assert.equal(none.label, 'None of these');
    assert.ok(p.content.includes('S'));
});

// Discord rejects the whole message (HTTP 400, "Must be between 1 and 5 in length") when an
// action row holds more than 5 buttons; the first live run hit this with 5 candidates + None.
test('buildPicker never puts more than 5 buttons in a row, for any number of candidates', () => {
    for (let n = 0; n <= 8; n++) {
        const p = buildPicker(entry(n));
        assert.ok(p.components.length >= 1 && p.components.length <= 5, `${n} candidates: rows`);
        for (const row of p.components) assert.ok(row.components.length >= 1 && row.components.length <= 5, `${n} candidates: row size ${row.components.length}`);
        assert.equal(p.components.flatMap((row) => row.components).length, Math.min(n, 5) + 1, `${n} candidates: total buttons`);
        assert.equal(p.components.at(-1).components.at(-1).custom_id, 'pick:e1:none');
    }
});

test('buildPicker truncates long labels and handles zero candidates', () => {
    const e = entry(1);
    e.candidates[0].title = 'L'.repeat(200);
    assert.ok(buildPicker(e).components[0].components[0].label.length <= 80);
    assert.equal(buildPicker(entry(0)).components[0].components.length, 1);
});

test('needsPicker', () => {
    assert.equal(needsPicker({ status: 'done', match: m({ confidence: 'unsure' }) }), true);
    assert.equal(needsPicker({ status: 'done', match: m() }), false);
    const c = [{ tconst: 'tt1' }];
    assert.equal(needsPicker({ status: 'failed', reason: 'not found on IMDb (tried: "A")', match: m({ confidence: 'none', candidates: c }) }), true);
    assert.equal(needsPicker({ status: 'failed', reason: 'not found on IMDb (tried: "A")', match: m({ confidence: 'none' }) }), false);
    assert.equal(needsPicker({ status: 'failed', reason: 'boom', match: m({ candidates: c }) }), false);
    assert.equal(needsPicker({ status: 'failed', stop: 'usage', reason: 'x' }), false);
});

test('parsePickId', () => {
    assert.deepEqual(parsePickId('pick:e1:tt123'), { id: 'e1', tconst: 'tt123' });
    assert.deepEqual(parsePickId('pick:e1:none'), { id: 'e1', tconst: null });
    for (const bad of ['pick:x', 'foo:a:b', '', 'pick:a:b:c', 'pick::tt1', null]) assert.equal(parsePickId(bad), null);
    const p = buildPicker(entry(2));
    for (const b of p.components[0].components) assert.ok(parsePickId(b.custom_id));
});
