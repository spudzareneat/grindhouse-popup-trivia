import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKillCounts, fetchKillCounts, KILLCOUNTS_URL } from '../src/killcounts.js';
import { textResponse } from './helpers.js';

const JSONL = [
    '{"tmdb_id":603,"count":12}',
    '',
    'not json at all',
    '{"title":"no id","count":5}',
    '{"tmdb_id":42,"count":0}',
    '{"tmdb_id":7}',
].join('\n');

test('KILLCOUNTS_URL points at the Kill-Count jsonl', () => {
    assert.equal(KILLCOUNTS_URL, 'https://raw.githubusercontent.com/lklynet/Kill-Count/main/killcounts.jsonl');
});
test('parseKillCounts keys by tmdb id and skips junk lines and entries without a count', () => {
    const m = parseKillCounts(JSONL);
    assert.equal(m.get('603'), 12);
    assert.equal(m.get('42'), 0);
    assert.equal(m.has('7'), false);
    assert.equal(m.size, 2);
});
test('fetchKillCounts downloads and parses the jsonl', async () => {
    let seen;
    const m = await fetchKillCounts(async (url) => { seen = url; return textResponse(JSONL); });
    assert.equal(seen, KILLCOUNTS_URL);
    assert.equal(m.get('603'), 12);
});
test('fetchKillCounts returns an empty map on an HTTP failure and on a thrown error (never throws)', async () => {
    assert.equal((await fetchKillCounts(async () => textResponse('x', 500))).size, 0);
    assert.equal((await fetchKillCounts(async () => { throw new Error('offline'); })).size, 0);
});
