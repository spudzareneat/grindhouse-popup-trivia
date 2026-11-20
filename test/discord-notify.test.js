import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePendingStore } from '../src/discord/pending.js';
import { notifyRun, notifyFailure, notifySessionExpiring } from '../src/discord/notify.js';
import { overrideKey } from '../src/overrides.js';

const cands = [{ tconst: 'tt1', title: 'A', year: 1999, source: 'imdb' }];
const done = { title: 'Fine', status: 'done', kept: 5, tconst: 'tt9', dataFile: 'data/fine.json', match: { confidence: 'sure', candidates: [] } };
const unsure = { title: 'Hmm', status: 'done', kept: 3, tconst: 'tt2', dataFile: 'data/hmm.json',
    match: { confidence: 'unsure', scheduleTitle: 'Hmm', scheduleYear: 1980, candidates: cands, matchedTitle: 'Hmm2' } };
const notFound = { title: 'Lost', status: 'failed', reason: 'not found on IMDb',
    match: { confidence: 'none', scheduleTitle: 'Lost', scheduleYear: 1970, candidates: cands } };
const noCands = { title: 'Gone', status: 'failed', reason: 'not found on IMDb',
    match: { confidence: 'none', scheduleTitle: 'Gone', scheduleYear: 1960, candidates: [] } };

function setup(apiOver = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
    const store = makePendingStore(path.join(dir, 'p.json'));
    const posted = [];
    let n = 0;
    const api = { postMessage: async (p) => { posted.push(p); return { id: `m${++n}` }; }, ...apiOver };
    const logs = [];
    return { dir, store, api, posted, logs, log: (...m) => logs.push(m.join(' ')) };
}

test('posts summary then a picker per problem result', async () => {
    const t = setup();
    try {
        await notifyRun({ api: t.api, store: t.store, results: [done, unsure, notFound], postTitle: 'Show', log: t.log });
        assert.equal(t.posted.length, 3);
        assert.ok(t.posted[0].embeds);
        assert.ok(t.posted[1].components && t.posted[2].components);
        const list = t.store.list();
        assert.equal(list.length, 2);
        assert.ok(list.every(e => e.status === 'open' && e.messageId));
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('no problems posts only the summary', async () => {
    const t = setup();
    try {
        await notifyRun({ api: t.api, store: t.store, results: [done, { title: 'x', status: 'failed', reason: 'boom' }], log: t.log });
        assert.equal(t.posted.length, 1);
        assert.equal(t.store.list().length, 0);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('postMessage rejecting does not throw and logs', async () => {
    const t = setup({ postMessage: async () => { throw new Error('discord down'); } });
    try {
        await notifyRun({ api: t.api, store: t.store, results: [unsure], log: t.log });
        assert.ok(t.logs.some(l => l.includes('discord down')));
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('unsure-done stores guess; not-found stores null guess', async () => {
    const t = setup();
    try {
        await notifyRun({ api: t.api, store: t.store, results: [unsure, notFound], log: t.log });
        const [a, b] = t.store.list();
        assert.equal(a.guessTconst, 'tt2');
        assert.equal(a.guessFile, 'data/hmm.json');
        assert.equal(b.guessTconst, null);
        assert.equal(b.guessFile, null);
        assert.equal(a.scheduleTitle, 'Hmm');
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('failed result with zero candidates gets no picker; resultless-match is fine', async () => {
    const t = setup();
    try {
        await notifyRun({ api: t.api, store: t.store, results: [noCands, { title: 's', status: 'skipped' }], log: t.log });
        assert.equal(t.posted.length, 1);
        assert.equal(t.store.list().length, 0);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('one failing picker does not stop the next', async () => {
    let calls = 0;
    const t = setup({ postMessage: async (p) => { calls++; if (calls === 2) throw new Error('picker boom'); return { id: `m${calls}` }; } });
    try {
        await notifyRun({ api: t.api, store: t.store, results: [unsure, notFound], log: t.log });
        assert.equal(calls, 3);
        assert.ok(t.logs.some(l => l.includes('picker boom')));
        const withIds = t.store.list().filter(e => e.messageId);
        assert.equal(withIds.length, 1);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

const skippedUnsure = { title: 'Hmm', status: 'skipped', tconst: 'tt2', reason: 'already has a file',
    match: { confidence: 'unsure', scheduleTitle: 'Hmm', scheduleYear: 1980, candidates: cands, matchedTitle: 'Hmm2' } };

test('skipped+unsure (already has a file) counts as the guess, with its data file', async () => {
    const t = setup();
    try {
        await notifyRun({ api: t.api, store: t.store, results: [skippedUnsure], dataDir: path.join(t.dir, 'data'), log: t.log });
        const [e] = t.store.list();
        assert.equal(e.guessTconst, 'tt2');
        assert.equal(e.guessFile, path.join(t.dir, 'data', 'tt2.json'));
        const noDir = setup();
        await notifyRun({ api: noDir.api, store: noDir.store, results: [skippedUnsure], log: noDir.log });
        assert.equal(noDir.store.list()[0].guessTconst, 'tt2');
        assert.equal(noDir.store.list()[0].guessFile, null);
        fs.rmSync(noDir.dir, { recursive: true, force: true });
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('no second picker while an open or running entry has the same override key', async () => {
    const t = setup();
    try {
        const id = t.store.add({ scheduleTitle: 'HMM', scheduleYear: 1980, candidates: cands, guessTconst: 'tt2', guessFile: null, messageId: 'm0' });
        await notifyRun({ api: t.api, store: t.store, results: [skippedUnsure], log: t.log });
        assert.equal(t.store.list().length, 1);
        t.store.update(id, { status: 'running' });
        await notifyRun({ api: t.api, store: t.store, results: [skippedUnsure], log: t.log });
        assert.equal(t.store.list().length, 1);
        t.store.update(id, { status: 'done' });
        await notifyRun({ api: t.api, store: t.store, results: [skippedUnsure], log: t.log });
        assert.equal(t.store.list().length, 2);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a dismissed title gets no picker', async () => {
    const t = setup();
    try {
        await notifyRun({ api: t.api, store: t.store, results: [unsure, notFound], dismissed: { [overrideKey('Hmm', 1980)]: true }, log: t.log });
        assert.deepEqual(t.store.list().map(e => e.scheduleTitle), ['Lost']);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('notifyFailure posts a truncated "Run failed" embed and never throws', async () => {
    const posted = [];
    await notifyFailure({ api: { postMessage: async (p) => { posted.push(p); return { id: 'x' }; } }, error: new Error('x'.repeat(900)) });
    const d = posted[0].embeds[0].description;
    assert.match(d, /^Run failed: x+/);
    assert.ok(d.length <= 'Run failed: '.length + 500);
    const logs = [];
    await notifyFailure({ api: { postMessage: async () => { throw new Error('discord down'); } }, error: 'boom', log: (m) => logs.push(m) });
    assert.ok(logs.some(l => l.includes('discord down')));
    await notifyFailure({ api: null, error: null });
});

// First live run: both pickers were rejected by Discord (HTTP 400), yet their store entries stayed
// "open", and the one-picker-per-title rule then blocked every later attempt for those titles.
test('a picker that fails to post is not left open, so the next run can post it', async () => {
    const t = setup({ postMessage: async (p) => { if (p.components) throw new Error('HTTP 400'); return { id: 'sum' }; } });
    try {
        await notifyRun({ api: t.api, store: t.store, results: [notFound], log: t.log });
        assert.ok(t.logs.some(l => l.includes('HTTP 400')));
        assert.equal(t.store.list().filter(e => e.status === 'open').length, 0);

        const second = setup();
        second.store = t.store;
        await notifyRun({ api: second.api, store: t.store, results: [notFound], log: second.log });
        assert.equal(second.posted.filter(p => p.components).length, 1);
        const open = t.store.list().filter(e => e.status === 'open');
        assert.equal(open.length, 1);
        assert.ok(open[0].messageId);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('an open entry that never got a message (left by an older failed post) does not block a new picker', async () => {
    const t = setup();
    try {
        t.store.add({ scheduleTitle: notFound.match.scheduleTitle, scheduleYear: notFound.match.scheduleYear, candidates: cands, guessTconst: null, guessFile: null, messageId: null });
        await notifyRun({ api: t.api, store: t.store, results: [notFound], log: t.log });
        assert.equal(t.posted.filter(p => p.components).length, 1);
        assert.ok(t.store.list().some(e => e.status === 'open' && e.messageId));
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

// Reddit login renewal reminders (the scrape needs a logged-in session; see README "Reddit session").
const DAY = 86400000;
const NOW = Date.parse('2026-11-20T12:00:00Z');
const inDays = n => Math.floor((NOW + n * DAY) / 1000);
function expiryEnv() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expiry-'));
    const posted = [];
    return { dir, posted, markerFile: path.join(dir, 'sub', 'warned'), api: { postMessage: async p => { posted.push(p); return { id: 'x' }; } } };
}

test('notifySessionExpiring stays quiet while the session has more than 30 days left, or no expiry is known', async () => {
    const t = expiryEnv();
    try {
        assert.equal(await notifySessionExpiring({ api: t.api, expiresAt: inDays(31), now: NOW, markerFile: t.markerFile }), false);
        assert.equal(await notifySessionExpiring({ api: t.api, expiresAt: null, now: NOW, markerFile: t.markerFile }), false);
        assert.equal(t.posted.length, 0);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
test('notifySessionExpiring warns with the days left, the date and the renewal steps, at most once a day', async () => {
    const t = expiryEnv();
    try {
        assert.equal(await notifySessionExpiring({ api: t.api, expiresAt: inDays(12), now: NOW, markerFile: t.markerFile }), true);
        const e = t.posted[0].embeds[0];
        assert.match(e.title, /Reddit login/);
        assert.match(e.description, /expires in 12 days \(2026-12-02\)/);
        assert.match(e.description, /Cookie-Editor/);
        assert.match(e.description, /REDDIT_COOKIES_PATH/);
        assert.match(e.description, /no redeploy/i);
        // Same day: no second post. Next day: warns again.
        assert.equal(await notifySessionExpiring({ api: t.api, expiresAt: inDays(12), now: NOW + 3600000, markerFile: t.markerFile }), false);
        assert.equal(await notifySessionExpiring({ api: t.api, expiresAt: inDays(12), now: NOW + DAY, markerFile: t.markerFile }), true);
        assert.equal(t.posted.length, 2);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
test('notifySessionExpiring says "has expired" for a past expiry, and a failed post is not recorded so it retries', async () => {
    const t = expiryEnv();
    try {
        await notifySessionExpiring({ api: t.api, expiresAt: inDays(-2), now: NOW, markerFile: t.markerFile });
        assert.match(t.posted[0].embeds[0].description, /has expired/);
        const logs = [];
        const bad = { postMessage: async () => { throw new Error('discord down'); } };
        assert.equal(await notifySessionExpiring({ api: bad, expiresAt: inDays(5), now: NOW + 2 * DAY, markerFile: t.markerFile, log: m => logs.push(m) }), false);
        assert.ok(logs.some(l => l.includes('discord down')));
        assert.equal(await notifySessionExpiring({ api: t.api, expiresAt: inDays(5), now: NOW + 2 * DAY, markerFile: t.markerFile }), true);
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
test('notifyFailure appends an error hint (the renewal steps for an expired Reddit session)', async () => {
    const posted = [];
    const err = Object.assign(new Error('Reddit session expired'), { hint: 'DO THE STEPS' });
    await notifyFailure({ api: { postMessage: async p => { posted.push(p); return { id: 'x' }; } }, error: err });
    assert.match(posted[0].embeds[0].description, /Run failed: Reddit session expired\n\nDO THE STEPS/);
});
