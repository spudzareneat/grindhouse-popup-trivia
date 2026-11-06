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
    const opts = { isAlive: () => true, sleep: tick };
    const job = name => withLock(f, async () => {
        order.push(`start ${name}`);
        for (let i = 0; i < 5; i++) await tick();
        order.push(`end ${name}`);
    }, opts);
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
