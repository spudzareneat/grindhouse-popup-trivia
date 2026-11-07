import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock } from '../src/lock.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), '.cache', 'run.lock');
const tick = () => new Promise(r => setImmediate(r));

test('runs fn, returns its value and removes the lock file', async () => {
    const f = tmp();
    const r = await withLock(f, async () => { assert.ok(fs.existsSync(f)); return 42; });
    assert.equal(r, 42);
    assert.equal(fs.existsSync(f), false);
});

test('two concurrent calls run strictly one after the other', async () => {
    const f = tmp();
    const order = [];
    const pids = { a: 111, b: 222 };   // distinct owners: a lock naming our own pid counts as stale
    const job = name => withLock(f, async () => {
        order.push(`start ${name}`);
        for (let i = 0; i < 5; i++) await tick();
        order.push(`end ${name}`);
    }, { isAlive: () => true, sleep: tick, pid: pids[name] });
    await Promise.all([job('a'), job('b')]);
    assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b']);
});

test('a lock naming a dead pid is taken over', async () => {
    const f = tmp();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '999999');
    let ran = false;
    await withLock(f, async () => { ran = true; }, { isAlive: () => false, sleep: async () => { throw new Error('should not wait'); } });
    assert.ok(ran);
    assert.equal(fs.existsSync(f), false);
});

test('an empty or unreadable lock file is taken over', async () => {
    const f = tmp();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(f, old, old);
    let ran = false;
    await withLock(f, async () => { ran = true; }, { isAlive: () => true, sleep: async () => { throw new Error('should not wait'); } });
    assert.ok(ran);
});

test('a lock held by a live pid blocks until released, and reports waiting once', async () => {
    const f = tmp();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '12345');
    let sleeps = 0, waits = 0, ran = false;
    const sleep = async () => { if (++sleeps === 3) fs.rmSync(f); };
    await withLock(f, async () => { ran = true; }, { isAlive: () => true, sleep, onWait: () => { waits++; } });
    assert.ok(ran);
    assert.equal(sleeps, 3);
    assert.equal(waits, 1);
});

test('releases the lock when fn throws', async () => {
    const f = tmp();
    await assert.rejects(withLock(f, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(fs.existsSync(f), false);
});

test('release leaves a lock now owned by someone else untouched', async () => {
    const f = tmp();
    await withLock(f, async () => { fs.writeFileSync(f, '4242'); });
    assert.equal(fs.readFileSync(f, 'utf8'), '4242');
});

test('a fresh empty lock is not taken over; an old empty one is', async () => {
    const f = tmp();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
    let sleeps = 0, ran = false;
    const sleep = async () => { if (++sleeps === 2) { const old = new Date(Date.now() - 60000); fs.utimesSync(f, old, old); } };
    await withLock(f, async () => { ran = true; assert.ok(sleeps >= 2); }, { isAlive: () => true, sleep });
    assert.ok(ran);
    assert.equal(sleeps, 2);
});

test('takeover and normal runs leave no .stale/.tmp litter', async () => {
    const f = tmp();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '999999');
    await withLock(f, async () => {}, { isAlive: () => false });
    await withLock(f, async () => {});
    assert.deepEqual(fs.readdirSync(path.dirname(f)), []);
});

test('a live lock moved aside by a race is restored and waited on', async () => {
    const f = tmp();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '777');
    // First check says dead (stale), the recheck after the rename says alive.
    let calls = 0, sleeps = 0, ran = false;
    const isAlive = () => ++calls > 1;
    const sleep = async () => { if (++sleeps === 1) assert.equal(fs.readFileSync(f, 'utf8'), '777'); fs.rmSync(f); };
    await withLock(f, async () => { ran = true; }, { isAlive, sleep });
    assert.ok(ran);
    assert.equal(sleeps, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(f)), []);
});

test('a lock naming our own pid is stale (pid reuse after a container restart) and is taken over', async () => {
    const f = tmp();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(process.pid));
    let ran = false;
    await withLock(f, async () => { ran = true; }, { isAlive: () => true, sleep: async () => { throw new Error('should not wait'); } });
    assert.ok(ran);
    assert.equal(fs.existsSync(f), false);
});
