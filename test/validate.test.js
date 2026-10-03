import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFacts, buildDoc } from '../src/validate.js';
import { ICON_KEYS, MODEL_OUTPUT_SCHEMA } from '../src/schema.js';

const F = (t, text, extra = {}) => ({ t, rank: 1, anchor: 'spread', text, icon: 'reel', byline: null, source: { type: 'imdb' }, ...extra });

test('icon contract is exact and in order', () => {
    assert.deepEqual(ICON_KEYS, ['skull', 'tombstone', 'reel', 'saucer', 'alien', 'rocket', 'robot', 'radioactive',
        'explosion', 'crosshair', 'knuckles', 'disco', 'boombox', 'sunglasses',
        'joebob', 'money', 'camera', 'star', 'link', 'mic', 'censor', 'trophy']);
    assert.deepEqual(MODEL_OUTPUT_SCHEMA.properties.facts.items.properties.icon.enum, ICON_KEYS);
});
test('keeps good facts, sorted, normalized', () => {
    const { facts, dropped } = validateFacts([F(300, ' b  text '), F(120, 'a', { rank: 7, anchor: 'weird', byline: ' Joe Bob ' })], 4680);
    assert.deepEqual(facts.map(f => [f.t, f.text, f.rank, f.anchor, f.byline]), [[120, 'a', 2, 'spread', 'Joe Bob'], [300, 'b text', 1, 'spread', null]]);
    assert.deepEqual(dropped, {});
});
test('drops uncited web/interview facts, keeps cited ones (url kept)', () => {
    const { facts, dropped } = validateFacts([
        F(100, 'x', { source: { type: 'web' } }),
        F(200, 'y', { source: { type: 'interview', url: 'ftp://nope' } }),
        F(300, 'z', { source: { type: 'web', url: 'https://example.com/a' } }),
    ], 4680);
    assert.deepEqual(facts.map(f => f.source), [{ type: 'web', url: 'https://example.com/a' }]);
    assert.equal(dropped.uncited, 2);
});
test('drops too-long, empty, bad icon, bad source, bad t, non-objects', () => {
    const { facts, dropped } = validateFacts([
        F(100, 'x'.repeat(201)), F(110, '   '), F(120, 'i', { icon: 'kitten' }), F(130, 's', { source: { type: 'blog' } }),
        F('140', 't'), null, F(400, 'ok'),
    ], 4680);
    assert.deepEqual(facts.map(f => f.text), ['ok']);
    assert.deepEqual(dropped, { 'too-long': 1, 'no-text': 1, 'bad-icon': 1, 'bad-source': 1, 'bad-t': 1, malformed: 1 });
});
test('clamps t into [60, runtime-30] and rounds', () => {
    const { facts } = validateFacts([F(5, 'early'), F(9999.4, 'late')], 4680);
    assert.deepEqual(facts.map(f => f.t), [60, 4650]);
});
test('no runtime known -> only the 60s floor applies', () => {
    assert.deepEqual(validateFacts([F(99999, 'x')], null).facts.map(f => f.t), [99999]);
});
test('enforces 45s spacing by shifting later facts, drops when no room', () => {
    const { facts, dropped } = validateFacts([F(100, 'a'), F(110, 'b'), F(120, 'c'), F(4640, 'd'), F(4645, 'e')], 4680);
    assert.deepEqual(facts.map(f => [f.text, f.t]), [['a', 100], ['b', 145], ['c', 190], ['d', 4640]]);
    assert.equal(dropped['no-room'], 1);
});
test('dedupes identical text case-insensitively', () => {
    const { facts, dropped } = validateFacts([F(100, 'Same fact.'), F(500, 'same FACT.')], 4680);
    assert.equal(facts.length, 1);
    assert.equal(dropped.duplicate, 1);
});
test('non-array input -> empty', () => {
    assert.deepEqual(validateFacts(undefined, 100).facts, []);
});
test('buildDoc shape', () => {
    const d = buildDoc({ imdbId: 'tt1', title: 'T', year: 1999, runtimeSec: 5000, facts: [], generatedAt: '2026-10-03T00:00:00Z' });
    assert.deepEqual(d, { schema: 1, imdbId: 'tt1', title: 'T', year: 1999, runtimeSec: 5000, generatedAt: '2026-10-03T00:00:00Z', facts: [] });
});

test('person tag kept only for fetched people; image always comes from our map', () => {
    const imgs = { nm1: 'https://m.media-amazon.com/images/M/x._V1_QL75_UX120_CR0,0,120,120_.jpg', nm2: null };
    const { facts } = validateFacts([
        F(100, 'about nm1', { person: 'nm1', image: 'https://evil.example/x.jpg' }),
        F(200, 'about nm2 (no photo)', { person: 'nm2' }),
        F(300, 'unknown person', { person: 'nm999' }),
        F(400, 'no person'),
    ], 4680, imgs);
    assert.deepEqual(facts.map(f => [f.text, f.person ?? null, f.image ?? null]), [
        ['about nm1', 'nm1', imgs.nm1],
        ['about nm2 (no photo)', 'nm2', null],
        ['unknown person', null, null],
        ['no person', null, null],
    ]);
    assert.equal('image' in facts[1], false);
    assert.equal('person' in facts[2], false);
});
test('person tag ignored when no people map given', () => {
    assert.equal('person' in validateFacts([F(100, 'x', { person: 'nm1' })], 4680).facts[0], false);
});
test('MODEL_OUTPUT_SCHEMA allows an optional person tag', () => {
    assert.deepEqual(MODEL_OUTPUT_SCHEMA.properties.facts.items.properties.person, { type: 'string' });
    assert.equal(MODEL_OUTPUT_SCHEMA.properties.facts.items.required.includes('person'), false);
});
