import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { makePendingStore } from '../src/discord/pending.js';
import { makeInteractionHandler, recoverInterrupted, makeSaveChoice, makeRunMovie } from '../src/discord/bot.js';
import { loadOverrides, overrideKey } from '../src/overrides.js';

const cands = [
    { tconst: 'tt1', title: 'Guess', year: 1999, source: 'imdb' },
    { tconst: 'tt2', title: 'Other', year: 1998, source: 'imdb' },
];

function setup(over = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-'));
    const store = makePendingStore(path.join(dir, 'p.json'));
    const id = store.add({ scheduleTitle: 'Movie', scheduleYear: 1999, candidates: cands, guessTconst: 'tt1', guessFile: 'data/tt1.json', messageId: null });
    const acks = [], edits = [], calls = [], logs = [];
    const api = {
        ackInteraction: async (i, type, data) => { acks.push({ type, data }); },
        editMessage: async (mid, p) => { edits.push({ mid, p }); },
    };
    const saveChoice = over.saveChoice ?? (async ({ tconst }) => { calls.push(['save', tconst]); });
    const runMovie = over.runMovie ?? (async ({ tconst, replaces }) => { calls.push(['run', tconst, replaces]); return { ok: true }; });
    const handler = makeInteractionHandler({ api, store, ownerId: 'owner', channelId: 'ch', saveChoice, runMovie, log: (m) => logs.push(m) });
    const click = (customId, o = {}) => ({ id: 'i', token: 't', type: 3, channel_id: 'ch', member: { user: { id: 'owner' } },
        data: { custom_id: customId, component_type: 2 }, message: { id: 'm1' }, ...o });
    return { dir, store, id, acks, edits, calls, logs, handler, click, api };
}
const last = (a) => a[a.length - 1];

test('other candidate: save then run with replaces, success edit, done', async () => {
    const t = setup();
    await t.handler(t.click(`pick:${t.id}:tt2`));
    assert.deepEqual(t.calls, [['save', 'tt2'], ['run', 'tt2', 'tt1']]);
    assert.equal(t.acks[0].type, 7);
    assert.match(t.acks[0].data.content, /Queued/);
    assert.deepEqual(t.acks[0].data.components, []);
    assert.equal(last(t.edits).mid, 'm1');
    assert.match(last(t.edits).p.content, /Done/);
    assert.equal(t.store.get(t.id).status, 'done');
});

test('runMovie failure shows reason and picker buttons, entry back to open', async () => {
    const t = setup({ runMovie: async () => ({ ok: false, reason: 'boom happened' }) });
    await t.handler(t.click(`pick:${t.id}:tt2`));
    const e = last(t.edits).p;
    assert.match(e.content, /boom happened/);
    assert.equal(e.components[0].components.length, 3);
    assert.equal(t.store.get(t.id).status, 'open');
});

test('two quick clicks on same picker run once', async () => {
    const t = setup();
    await Promise.all([t.handler(t.click(`pick:${t.id}:tt2`)), t.handler(t.click(`pick:${t.id}:tt2`))]);
    assert.equal(t.calls.filter((c) => c[0] === 'run').length, 1);
    assert.equal(t.acks.length, 2);
    assert.equal(t.acks[1].type, 6);
});

test('non-owner gets ephemeral denial and nothing runs', async () => {
    const t = setup();
    await t.handler(t.click(`pick:${t.id}:tt2`, { member: { user: { id: 'x' } } }));
    assert.deepEqual(t.calls, []);
    assert.equal(t.acks[0].type, 4);
    assert.equal(t.acks[0].data.flags, 64);
    assert.match(t.acks[0].data.content, /Only the owner/);
    assert.equal(t.store.get(t.id).status, 'open');
    assert.equal(t.edits.length, 0);
});

test('unknown pending id updates message to expired', async () => {
    const t = setup();
    await t.handler(t.click('pick:nope:tt2'));
    assert.equal(t.acks[0].type, 7);
    assert.match(t.acks[0].data.content, /expired/i);
    assert.deepEqual(t.calls, []);
});

test('click on guess saves but does not run; confirmed', async () => {
    const t = setup();
    await t.handler(t.click(`pick:${t.id}:tt1`));
    assert.deepEqual(t.calls, [['save', 'tt1']]);
    assert.match(last(t.edits).p.content, /Confirmed/);
    assert.equal(t.store.get(t.id).status, 'done');
});

test('None of these saves a dismissal', async () => {
    const t = setup();
    await t.handler(t.click(`pick:${t.id}:none`));
    assert.deepEqual(t.calls, [['save', null]]);
    assert.equal(t.store.get(t.id).status, 'dismissed');
    assert.equal(last(t.edits).mid, 'm1');
});

test('saveChoice failure returns entry to open with picker', async () => {
    const t = setup({ saveChoice: async () => { throw new Error('push rejected'); } });
    await t.handler(t.click(`pick:${t.id}:tt2`));
    assert.equal(t.store.get(t.id).status, 'open');
    assert.match(last(t.edits).p.content, /push rejected/);
    assert.ok(last(t.edits).p.components.length);
});

test('different pickers run sequentially', async () => {
    const order = [];
    const gates = [];
    const t = setup({
        saveChoice: async ({ entry }) => { order.push(`save ${entry.id}`); },
        runMovie: ({ tconst }) => new Promise((res) => {
            order.push(`run-start ${tconst}`);
            gates.push(() => { order.push(`run-end ${tconst}`); res({ ok: true }); });
        }),
    });
    const id2 = t.store.add({ scheduleTitle: 'Two', scheduleYear: 2000, candidates: cands, guessTconst: 'tt1', messageId: null });
    const p1 = t.handler(t.click(`pick:${t.id}:tt2`));
    const p2 = t.handler(t.click(`pick:${id2}:tt2`, { message: { id: 'm2' } }));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order, [`save ${t.id}`, 'run-start tt2']);
    gates[0]();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(order.slice(2), ['run-end tt2', `save ${id2}`, 'run-start tt2']);
    gates[1]();
    await Promise.all([p1, p2]);
    assert.equal(t.store.get(id2).status, 'done');
});

test('other channel and non-button interactions are ignored', async () => {
    const t = setup();
    await t.handler(t.click(`pick:${t.id}:tt2`, { channel_id: 'other' }));
    await t.handler(t.click(`pick:${t.id}:tt2`, { type: 2 }));
    await t.handler(t.click('garbage'));
    assert.deepEqual(t.acks, []);
    assert.deepEqual(t.calls, []);
    assert.equal(t.store.get(t.id).status, 'open');
});

test('works when entry messageId is null and uses interaction message id', async () => {
    const t = setup();
    await t.handler(t.click(`pick:${t.id}:tt1`));
    assert.equal(last(t.edits).mid, 'm1');
});

test('recoverInterrupted reopens running entries and edits their message', async () => {
    const t = setup();
    const id2 = t.store.add({ scheduleTitle: 'Two', scheduleYear: 2000, candidates: cands, guessTconst: null, messageId: 'm9' });
    t.store.update(id2, { status: 'running' });
    t.store.update(t.id, { status: 'running' });
    await recoverInterrupted({ api: t.api, store: t.store, log: () => {} });
    assert.equal(t.store.get(id2).status, 'open');
    assert.equal(t.store.get(t.id).status, 'open');
    assert.equal(t.edits.length, 1);
    assert.equal(t.edits[0].mid, 'm9');
    assert.match(t.edits[0].p.content, /Interrupted - click again/);
    assert.ok(t.edits[0].p.components.length);
});

test('saveChoice records override and commits under lock; lock released before return', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-'));
    const gitCalls = [];
    const git = { pull: () => gitCalls.push(['pull']), commitAndPush: (f, m) => { gitCalls.push(['commit', f, m]); } };
    const save = makeSaveChoice({ repoDir: dir, git });
    const entry = { scheduleTitle: 'Movie', scheduleYear: 1999 };
    const file = path.join(dir, 'overrides', 'title-overrides.json');
    await save({ entry, tconst: 'tt2' });
    assert.equal(loadOverrides(file).picks[overrideKey('Movie', 1999)], 'tt2');
    assert.equal(gitCalls[0][0], 'pull');
    assert.equal(gitCalls[1][1], file);
    assert.equal(fs.existsSync(path.join(dir, '.cache', 'run.lock')), false);
    await save({ entry, tconst: null });
    const o = loadOverrides(file);
    assert.equal(o.dismissed[overrideKey('Movie', 1999)], true);
    assert.equal(o.picks[overrideKey('Movie', 1999)], undefined);
});

test('runMovie spawns the CLI and reports ok / last line', async () => {
    const spawned = [];
    const mk = (code, out) => (cmd, args, opts) => {
        spawned.push([cmd, args, opts]);
        const ch = new EventEmitter();
        ch.stdout = new EventEmitter();
        ch.stderr = new EventEmitter();
        setImmediate(() => { ch.stdout.emit('data', Buffer.from(out)); ch.emit('close', code); });
        return ch;
    };
    const ok = await makeRunMovie({ spawnImpl: mk(0, 'fine\n') })({ tconst: 'tt2', replaces: 'tt1' });
    assert.deepEqual(ok, { ok: true });
    assert.equal(spawned[0][0], process.execPath);
    assert.deepEqual(spawned[0][1].slice(1), ['movie', 'tt2', '--replaces', 'tt1']);
    assert.ok(path.isAbsolute(spawned[0][1][0]) && spawned[0][1][0].endsWith('cli.js'));
    const bad = await makeRunMovie({ spawnImpl: mk(1, 'a\nlast line here\n\n') })({ tconst: 'tt2', replaces: null });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'last line here');
    assert.deepEqual(spawned[1][1].slice(1), ['movie', 'tt2']);
});

test('runMovie recognises a skipped result from the CLI log line', async () => {
    const mk = (out) => () => {
        const ch = new EventEmitter();
        ch.stdout = new EventEmitter();
        ch.stderr = new EventEmitter();
        setImmediate(() => { ch.stdout.emit('data', Buffer.from(out)); ch.emit('close', 0); });
        return ch;
    };
    const a = await makeRunMovie({ spawnImpl: mk('x\n2026-11-06T10:00:00.000Z skipped: already has a file — removed tt1\r\n') })({ tconst: 'tt2', replaces: 'tt1' });
    assert.deepEqual(a, { ok: true, skipped: true, removed: 'tt1' });
    const b = await makeRunMovie({ spawnImpl: mk('2026-11-06T10:00:00.000Z skipped: already has a file\n') })({ tconst: 'tt2' });
    assert.deepEqual(b, { ok: true, skipped: true });
    const c = await makeRunMovie({ spawnImpl: mk('2026-11-06T10:00:00.000Z done — 12 facts\n') })({ tconst: 'tt2' });
    assert.deepEqual(c, { ok: true });
});

test('skipped result edits the message to "already existed", not "Done: generated"', async () => {
    const t = setup({ runMovie: async () => ({ ok: true, skipped: true, removed: 'tt1' }) });
    await t.handler(t.click(`pick:${t.id}:tt2`));
    assert.match(last(t.edits).p.content, /tt2 already existed; removed guess tt1/);
    assert.doesNotMatch(last(t.edits).p.content, /Done/);
    assert.equal(t.store.get(t.id).status, 'done');
    const u = setup({ runMovie: async () => ({ ok: true, skipped: true }) });
    await u.handler(u.click(`pick:${u.id}:tt2`));
    assert.match(last(u.edits).p.content, /already existed/);
    assert.doesNotMatch(last(u.edits).p.content, /removed/);
});

test('a pick not offered by the picker (or not a tconst) is ignored with a log and no state change', async () => {
    const t = setup();
    for (const bad of ['tt999', 'abc', 'tt1x']) await t.handler(t.click(`pick:${t.id}:${bad}`));
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.acks, []);
    assert.equal(t.logs.length, 3);
    assert.equal(t.store.get(t.id).status, 'open');
});

test('failure texts say the best-guess file is still published', async () => {
    const t = setup({ runMovie: async () => ({ ok: false, reason: 'boom' }) });
    await t.handler(t.click(`pick:${t.id}:tt2`));
    assert.match(last(t.edits).p.content, /best-guess file .*tt1.* still published/);
    const u = setup({ saveChoice: async () => { throw new Error('push rejected'); } });
    await u.handler(u.click(`pick:${u.id}:tt2`));
    assert.match(last(u.edits).p.content, /push rejected\. The best-guess file .* still published/);
});
