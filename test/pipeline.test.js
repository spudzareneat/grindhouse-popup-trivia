import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processMovie, runWeekend, UsageLimitError, PublishError, summarize } from '../src/pipeline.js';
import { makeGit, writeDoc } from '../src/publish.js';

const fact = (t, text) => ({ t, rank: 1, anchor: 'spread', text, icon: 'reel', source: { type: 'imdb' } });
const FIVE = [fact(100, 'a'), fact(300, 'b'), fact(500, 'c'), fact(700, 'd'), fact(900, 'e')];

function makeDeps(over = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-test-'));
    const commits = [];
    const prompts = [];
    return {
        root, commits, prompts,
        deps: {
            imdb: {
                searchTitle: async (title, year) => title === 'Nope' ? null : { tconst: title === 'Show' ? 'tt9' : 'tt0055830', title, year },
                fetchBundle: async (tconst) => ({ tconst, title: 'Carnival of Souls', year: 1962, runtimeSec: 4680, isSeries: false, isEpisode: tconst === 'tt9', trivia: [], goofs: [], quotes: [], connections: [], alternateVersions: [], crazyCredits: [], soundtrack: [], filmingLocations: [], people: [] }),
            },
            wiki: { fetchWikidata: async () => ({ wikipediaTitle: 'Carnival of Souls' }), fetchWikipediaExtract: async () => 'WP' },
            tmdb: { fetchExtras: async () => { throw new Error('tmdb down'); } },
            totalsRows: [{ title: 'Carnival of Souls', year: 1962, description: 'Nineteen dead bodies.' }],
            runClaude: async (prompt) => { prompts.push(prompt); return { ok: true, usageLimited: false, facts: FIVE }; },
            model: 'sonnet',
            dataDir: path.join(root, 'data'),
            outDir: path.join(root, 'out'),
            git: { pull() {}, push() {}, commitAndPush(p, m) { commits.push({ p, m }); return true; } },
            force: false, dryRun: false,
            log: () => {},
            now: () => '2026-10-03T09:00:00.000Z',
            ...over,
        },
    };
}

test('processMovie: researches, validates, writes data/<id>.json, commits', async () => {
    const { deps, commits, prompts } = makeDeps();
    const r = await processMovie({ title: 'Carnival of Souls', year: 1962 }, deps);
    assert.equal(r.status, 'done');
    const doc = JSON.parse(fs.readFileSync(path.join(deps.dataDir, 'tt0055830.json'), 'utf8'));
    assert.equal(doc.schema, 1);
    assert.equal(doc.facts.length, 5);
    assert.equal(doc.generatedAt, '2026-10-03T09:00:00.000Z');
    assert.match(prompts[0], /Nineteen dead bodies/);   // totals reached the prompt
    assert.match(prompts[0], /WP/);                     // wikipedia reached it; tmdb failure tolerated
    assert.equal(commits.length, 1);
    assert.match(commits[0].m, /Carnival of Souls \(1962\)/);
});
test('processMovie: existing file skipped unless force', async () => {
    const { deps } = makeDeps();
    writeDoc(deps.dataDir, { imdbId: 'tt0055830' });
    assert.equal((await processMovie({ title: 'Carnival of Souls', year: 1962 }, deps)).status, 'skipped');
    assert.equal((await processMovie({ title: 'Carnival of Souls', year: 1962 }, { ...deps, force: true })).status, 'done');
});
test('processMovie: not on IMDb, TV episode, aka fallback', async () => {
    const { deps } = makeDeps();
    assert.equal((await processMovie({ title: 'Nope', year: 1970, akas: [] }, deps)).status, 'failed');
    assert.equal((await processMovie({ title: 'Show', year: 1970 }, deps)).reason, 'TV series/episode');
    assert.equal((await processMovie({ title: 'Nope', year: 1970, akas: ['Carnival of Souls'] }, deps)).status, 'done');
});
test('processMovie: tconst item skips search', async () => {
    const { deps } = makeDeps({ imdb: { ...makeDeps().deps.imdb, searchTitle: async () => { throw new Error('should not search'); } } });
    assert.equal((await processMovie({ tconst: 'tt0055830' }, deps)).status, 'done');
});
test('processMovie: retries once when too few valid facts, then fails', async () => {
    let calls = 0;
    const { deps } = makeDeps({ runClaude: async () => { calls++; return { ok: true, usageLimited: false, facts: FIVE.slice(0, 2) }; } });
    const r = await processMovie({ title: 'Carnival of Souls', year: 1962 }, deps);
    assert.equal(calls, 2);
    assert.equal(r.status, 'failed');
    assert.equal(fs.existsSync(path.join(deps.dataDir, 'tt0055830.json')), false);
});
test('processMovie: usage limit throws UsageLimitError', async () => {
    const { deps } = makeDeps({ runClaude: async () => ({ ok: false, usageLimited: true, error: 'limit' }) });
    await assert.rejects(processMovie({ title: 'Carnival of Souls', year: 1962 }, deps), UsageLimitError);
});
test('dry run writes to outDir only and never commits', async () => {
    const { deps, commits } = makeDeps({ dryRun: true });
    const r = await processMovie({ title: 'Carnival of Souls', year: 1962 }, deps);
    assert.equal(r.status, 'done');
    assert.equal(fs.existsSync(path.join(deps.outDir, 'tt0055830.json')), true);
    assert.equal(fs.existsSync(path.join(deps.dataDir, 'tt0055830.json')), false);
    assert.equal(commits.length, 0);
});
test('runWeekend: pulls, processes in order, sleeps between done movies, stops on usage limit', async () => {
    let n = 0, pulled = 0;
    const sleeps = [];
    const { deps } = makeDeps({
        git: { pull() { pulled++; }, push() {}, commitAndPush() { return true; } },
        runClaude: async () => (++n === 2 ? { ok: false, usageLimited: true, error: 'limit' } : { ok: true, usageLimited: false, facts: FIVE }),
        imdb: { ...makeDeps().deps.imdb, searchTitle: async (title) => ({ tconst: `tt${title.length}${title.charCodeAt(0)}`, title, year: 1962 }) },
    });
    const results = await runWeekend(deps, {
        fetchWeekend: async () => ({ postTitle: 'Sched', movies: [{ title: 'Aa', year: 1962 }, { title: 'Bbb', year: 1962 }, { title: 'Cccc', year: 1962 }] }),
        delayMs: 5, sleep: async ms => { sleeps.push(ms); },
    });
    assert.equal(pulled, 1);
    assert.deepEqual(results.map(r => r.status), ['done', 'failed']);
    assert.match(results[1].reason, /usage limit/);
    assert.deepEqual(sleeps, [5]);
    assert.match(summarize(results), /1 done, 0 skipped, 1 failed/);
});
test('makeGit: dry run is inert; real run adds, commits that file, pushes, retries push after rebase', () => {
    const cmds = [];
    let pushes = 0;
    const exec = (bin, args) => { cmds.push(args.slice(2).join(' ')); if (args[2] === 'push' && ++pushes === 1) throw new Error('rejected'); return ''; };
    assert.equal(makeGit('/r', { dryRun: true, exec }).commitAndPush('/r/data/x.json', 'm'), false);
    assert.deepEqual(cmds, []);
    makeGit('/r', { exec }).commitAndPush('/r/data/x.json', 'msg');
    assert.deepEqual(cmds, ['add -- /r/data/x.json', 'commit -m msg -- /r/data/x.json', 'push', 'pull --rebase --autostash', 'push']);
});

const THREE_MOVIES = { postTitle: 'Sched', movies: [{ title: 'Aa', year: 1962 }, { title: 'Bbb', year: 1962 }, { title: 'Cccc', year: 1962 }] };
const distinctImdb = () => ({ ...makeDeps().deps.imdb, searchTitle: async (title) => ({ tconst: `tt${title.length}${title.charCodeAt(0)}`, title, year: 1962 }) });
const noSleep = { delayMs: 0, sleep: async () => {} };

test('runWeekend: pulls then pushes (stranded commits / read-only key) before the first movie', async () => {
    const order = [];
    const { deps } = makeDeps({
        git: { pull() { order.push('pull'); }, push() { order.push('push'); }, commitAndPush() { order.push('commit'); return true; } },
        runClaude: async () => { order.push('claude'); return { ok: true, usageLimited: false, facts: FIVE }; },
        imdb: distinctImdb(),
    });
    await runWeekend(deps, { fetchWeekend: async () => ({ postTitle: 'S', movies: [{ title: 'Aa', year: 1962 }] }), ...noSleep });
    assert.deepEqual(order, ['pull', 'push', 'claude', 'commit']);
});
test('runWeekend: upfront push failure propagates before any Claude usage', async () => {
    let claude = 0;
    const { deps } = makeDeps({
        git: { pull() {}, push() { throw new Error('denied'); }, commitAndPush() { return true; } },
        runClaude: async () => { claude++; return { ok: true, usageLimited: false, facts: FIVE }; },
    });
    await assert.rejects(runWeekend(deps, { fetchWeekend: async () => THREE_MOVIES, ...noSleep }), /denied/);
    assert.equal(claude, 0);
});
test('runWeekend: a failed commitAndPush stops the run, next movie not processed', async () => {
    let claude = 0;
    const { deps } = makeDeps({
        git: { pull() {}, push() {}, commitAndPush() { throw new Error('push rejected'); } },
        runClaude: async () => { claude++; return { ok: true, usageLimited: false, facts: FIVE }; },
        imdb: distinctImdb(),
    });
    const results = await runWeekend(deps, { fetchWeekend: async () => THREE_MOVIES, ...noSleep });
    assert.equal(claude, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].reason, /git push failed/);
    assert.equal(results[0].stop, 'publish');
});
test('processMovie: commitAndPush error is rethrown as PublishError', async () => {
    const { deps } = makeDeps({ git: { pull() {}, push() {}, commitAndPush() { throw new Error('nope'); } } });
    await assert.rejects(processMovie({ title: 'Carnival of Souls', year: 1962 }, deps), PublishError);
});
test('runWeekend: auth error stops the run like a usage limit', async () => {
    const { deps } = makeDeps({ runClaude: async () => ({ ok: false, usageLimited: true, authError: true, error: 'Claude auth failed: Invalid API key' }), imdb: distinctImdb() });
    const results = await runWeekend(deps, { fetchWeekend: async () => THREE_MOVIES, ...noSleep });
    assert.equal(results.length, 1);
    assert.match(results[0].reason, /auth/);
    assert.equal(results[0].stop, 'usage');
});
test('runWeekend: logs the schedule Fri date and warns when the post looks stale', async () => {
    const logs = [];
    const { deps } = makeDeps({ log: m => logs.push(m), now: () => '2026-10-09T03:00:00.000Z' });
    await runWeekend(deps, { fetchWeekend: async () => ({ postTitle: 'Sched', weekendFri: '2026-10-03', movies: [] }), ...noSleep });
    assert.ok(logs.includes('Schedule: Sched (Fri 2026-10-03) — 0 movies'), logs.join('\n'));
    assert.ok(logs.some(l => l.includes('schedule post looks stale (Fri 2026-10-03) — new post may not be up yet')));
    const logs2 = [];
    const { deps: d2 } = makeDeps({ log: m => logs2.push(m), now: () => '2026-10-06T03:00:00.000Z' });
    await runWeekend(d2, { fetchWeekend: async () => ({ postTitle: 'Sched', weekendFri: '2026-10-03', movies: [] }), ...noSleep });
    assert.ok(!logs2.some(l => /stale/.test(l)));
});
test('processMovie: reason reflects the latest attempt (error, then too few facts); turns logged', async () => {
    let n = 0;
    const logs = [];
    const { deps } = makeDeps({
        log: m => logs.push(m),
        runClaude: async () => (++n === 1 ? { ok: false, usageLimited: false, error: 'timed out' } : { ok: true, usageLimited: false, facts: FIVE.slice(0, 3), numTurns: 12 }),
    });
    const r = await processMovie({ title: 'Carnival of Souls', year: 1962 }, deps);
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /only 3 valid facts/);
    assert.ok(logs.some(l => l.includes(', 12 turns')));
});
test('makeGit: pull uses --autostash; push() exists and is inert in dry run', () => {
    const cmds = [];
    const exec = (bin, args) => { cmds.push(args.slice(2).join(' ')); return ''; };
    const dry = makeGit('/r', { dryRun: true, exec });
    dry.pull(); dry.push();
    assert.deepEqual(cmds, []);
    const g = makeGit('/r', { exec });
    g.pull(); g.push();
    assert.deepEqual(cmds, ['pull --rebase --autostash', 'push']);
});
test('makeGit: retry failure runs rebase --abort (errors ignored) and rethrows', () => {
    const cmds = [];
    const exec = (bin, args) => {
        const c = args.slice(2).join(' ');
        cmds.push(c);
        if (c === 'push') throw new Error('rejected');
        if (c === 'rebase --abort') throw new Error('no rebase in progress');
        if (c.startsWith('pull')) throw new Error('conflict');
        return '';
    };
    assert.throws(() => makeGit('/r', { exec }).commitAndPush('/r/data/x.json', 'msg'), /conflict/);
    assert.deepEqual(cmds, ['add -- /r/data/x.json', 'commit -m msg -- /r/data/x.json', 'push', 'pull --rebase --autostash', 'rebase --abort']);
});
