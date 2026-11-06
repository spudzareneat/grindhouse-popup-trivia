import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateMatch, resolveTitle, SIMILARITY_STRONG, LEAD_RATIO } from '../src/resolve.js';
import { overrideKey } from '../src/overrides.js';

const C = (tconst, title, year, votes, source = 'imdb') => ({ tconst, title, year, votes, source });
const noOverrides = { picks: {}, dismissed: {} };

function stubs({ hit = null, imdbPool = [], tmdbPool = [], imdbCands = true, tmdbCands = true } = {}) {
  const calls = { search: [], imdbCands: [], tmdbCands: [] };
  const imdb = { searchTitle: async (t, y) => { calls.search.push([t, y]); return hit; } };
  if (imdbCands) imdb.searchCandidates = async t => { calls.imdbCands.push(t); return imdbPool; };
  const tmdb = {};
  if (tmdbCands) tmdb.searchCandidates = async t => { calls.tmdbCands.push(t); return tmdbPool; };
  return { imdb, tmdb, calls };
}
const run = (item, s) => resolveTitle(item, { imdb: s.imdb, tmdb: s.tmdb, overrides: noOverrides });

test('constants', () => { assert.equal(SIMILARITY_STRONG, 0.85); assert.equal(LEAD_RATIO, 0.5); });

test('rateMatch: null year is unsure, weak title is unsure, exact is confident', () => {
  const m = C('tt1', 'The Fly', 1986, 1000);
  assert.equal(rateMatch({ scheduleTitle: 'The Fly', scheduleYear: null, matched: m, pool: [m] }), 'unsure');
  assert.equal(rateMatch({ scheduleTitle: 'Something Else Entirely', scheduleYear: 1986, matched: m, pool: [m] }), 'unsure');
  assert.equal(rateMatch({ scheduleTitle: 'The Fly', scheduleYear: 1986, matched: m, pool: [m] }), 'confident');
});

test('tconst given resolves directly with no searches', async () => {
  const s = stubs();
  const r = await run({ title: 'X', year: 1990, tconst: 'tt9' }, s);
  assert.deepEqual([r.tconst, r.source, r.confidence], ['tt9', 'direct', 'confident']);
  assert.equal(s.calls.search.length + s.calls.imdbCands.length + s.calls.tmdbCands.length, 0);
});

test('override pick wins and skips searches', async () => {
  const s = stubs();
  const ov = { picks: { [overrideKey('Fly', 1958)]: 'tt42' }, dismissed: {} };
  const r = await resolveTitle({ title: 'Fly', year: 1958 }, { imdb: s.imdb, tmdb: s.tmdb, overrides: ov });
  assert.deepEqual([r.tconst, r.source, r.confidence], ['tt42', 'override', 'confident']);
  assert.equal(s.calls.search.length, 0);
});

const hit = { tconst: 'tt1', title: 'The Fly', year: 1986 };

test('IMDb exact hit with no rival is confident and gathers no picker candidates', async () => {
  const s = stubs({ hit, imdbPool: [C('tt1', 'The Fly', 1986, 1000)] });
  const r = await run({ title: 'The Fly', year: 1986 }, s);
  assert.deepEqual([r.tconst, r.source, r.confidence], ['tt1', 'imdb', 'confident']);
  assert.deepEqual(r.candidates, []);
  assert.equal(s.calls.tmdbCands.length, 0);
  assert.equal(s.calls.imdbCands.length, 1); // only the rival-check pool for the matched term
});

test('stubs without searchCandidates: resolved, no throw; null year is unsure', async () => {
  const s = stubs({ hit, imdbCands: false, tmdbCands: false });
  const r = await run({ title: 'The Fly', year: null }, s);
  assert.deepEqual([r.tconst, r.confidence], ['tt1', 'unsure']);
  const r2 = await run({ title: 'The Fly', year: 1986 }, s);
  assert.deepEqual([r2.tconst, r2.confidence], ['tt1', 'confident']);
});

test('rival with 60% of votes is unsure, with 20% is confident', async () => {
  const mk = rv => stubs({ hit, imdbPool: [C('tt1', 'The Fly', 1986, 1000), C('tt2', 'The Fly', 1987, rv)] });
  assert.equal((await run({ title: 'The Fly', year: 1986 }, mk(600))).confidence, 'unsure');
  assert.equal((await run({ title: 'The Fly', year: 1986 }, mk(200))).confidence, 'confident');
});

test('variant match is not weak and logs the matched term', async () => {
  const logs = [];
  const imdb = { searchTitle: async t => (t === 'Zombi 2' ? { tconst: 'tt1', title: 'Zombi 2', year: 1979 } : null), searchCandidates: async () => [] };
  const r = await resolveTitle({ title: 'Zombi 2: Part II', year: 1979 }, { imdb, tmdb: {}, overrides: noOverrides, log: m => logs.push(m) });
  assert.equal(r.confidence, 'confident');
  assert.ok(logs.some(l => l.includes('matched on IMDb as "Zombi 2"')));
});

test('TMDB fallback accepts a matching hit, rejects a year off by 3', async () => {
  const ok = stubs({ tmdbPool: [C('tt5', 'Zombi', 1979, 500, 'tmdb')] });
  const r = await run({ title: 'Zombi', year: 1979 }, ok);
  assert.deepEqual([r.tconst, r.source, r.confidence], ['tt5', 'tmdb', 'confident']);
  const bad = stubs({ tmdbPool: [C('tt5', 'Zombi', 1982, 500, 'tmdb')] });
  assert.equal((await run({ title: 'Zombi', year: 1979 }, bad)).tconst, null);
});

test('nothing found: none, tried listed, candidates ranked and capped at 5', async () => {
  const pool = Array.from({ length: 8 }, (_, i) => C(`tt${i}`, i === 3 ? 'Blob' : `Blob ${i}`, 1958, i * 10));
  const r = await run({ title: 'Blob', year: 1900, akas: ['Alias'] }, stubs({ imdbPool: pool }));
  assert.equal(r.tconst, null);
  assert.equal(r.confidence, 'none');
  assert.ok(r.tried.includes('Blob') && r.tried.includes('Alias'));
  assert.equal(r.candidates.length, 5);
  assert.equal(r.candidates[0].tconst, 'tt3');
});

test('nothing found with stubs lacking searchCandidates does not throw', async () => {
  const r = await run({ title: 'Blob', year: 1958 }, stubs({ imdbCands: false, tmdbCands: false }));
  assert.deepEqual([r.tconst, r.confidence, r.candidates], [null, 'none', []]);
});

test('rejecting imdb.searchCandidates in the rival check: still resolves, unsure, logged', async () => {
  const logs = [];
  const imdb = { searchTitle: async () => hit, searchCandidates: async () => { throw new Error('boom'); } };
  const r = await resolveTitle({ title: 'The Fly', year: 1986 }, { imdb, tmdb: {}, overrides: noOverrides, log: m => logs.push(m) });
  assert.deepEqual([r.tconst, r.confidence], ['tt1', 'unsure']);
  assert.ok(logs.some(l => l.includes('boom')));
});

test('synchronously throwing searchCandidates is caught and logged', async () => {
  const logs = [];
  const imdb = { searchTitle: async () => hit, searchCandidates: () => { throw new Error('sync'); } };
  const r = await resolveTitle({ title: 'The Fly', year: 1986 }, { imdb, tmdb: {}, overrides: noOverrides, log: m => logs.push(m) });
  assert.equal(r.confidence, 'unsure');
  assert.ok(logs.some(l => l.includes('sync')));
});

test('rejecting tmdb.searchCandidates in the fallback is treated as no hits', async () => {
  const logs = [];
  const imdb = { searchTitle: async () => null, searchCandidates: async () => [] };
  const tmdb = { searchCandidates: async () => { throw new Error('tmdb down'); } };
  const r = await resolveTitle({ title: 'Zombi', year: 1979 }, { imdb, tmdb, overrides: noOverrides, log: m => logs.push(m) });
  assert.deepEqual([r.tconst, r.confidence], [null, 'none']);
  assert.ok(logs.some(l => l.includes('tmdb down')));
});

test('candidates with a falsy tconst are never returned or picked', async () => {
  const s = stubs({ tmdbPool: [C(null, 'Zombi', 1979, 900, 'tmdb'), C('tt5', 'Zombi', 1979, 10, 'tmdb')] });
  const r = await run({ title: 'Zombi', year: 1979 }, s);
  assert.equal(r.tconst, 'tt5');
  const none = await run({ title: 'Zombi', year: 1979 }, stubs({ tmdbPool: [C(null, 'Zombi', 1979, 900, 'tmdb')] }));
  assert.deepEqual([none.tconst, none.candidates], [null, []]);
});

test('unsure results populate candidates including the matched tconst', async () => {
  const rival = stubs({ hit, imdbPool: [C('tt1', 'The Fly', 1986, 1000), C('tt2', 'The Fly', 1987, 600)] });
  const r = await run({ title: 'The Fly', year: 1986 }, rival);
  assert.equal(r.confidence, 'unsure');
  assert.ok(r.candidates.some(c => c.tconst === 'tt1'));
  const noYear = await run({ title: 'The Fly', year: null }, stubs({ hit, imdbPool: [C('tt1', 'The Fly', 1986, 1000)] }));
  assert.equal(noYear.confidence, 'unsure');
  assert.ok(noYear.candidates.some(c => c.tconst === 'tt1'));
});

test('TMDB fallback with no year resolves but is unsure', async () => {
  const r = await run({ title: 'Zombi', year: null }, stubs({ tmdbPool: [C('tt5', 'Zombi', 1979, 500, 'tmdb')] }));
  assert.deepEqual([r.tconst, r.source, r.confidence], ['tt5', 'tmdb', 'unsure']);
});
