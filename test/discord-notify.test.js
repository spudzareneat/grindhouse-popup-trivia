import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePendingStore } from '../src/discord/pending.js';
import { notifyRun } from '../src/discord/notify.js';

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
