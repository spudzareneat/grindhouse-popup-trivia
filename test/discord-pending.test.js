import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePendingStore } from '../src/discord/pending.js';

function tmpFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-'));
    return { dir, file: path.join(dir, 'sub', 'p.json') };
}

const entry = { scheduleTitle: 'T', scheduleYear: 1999, candidates: [], guessTconst: null, guessFile: null, messageId: null };

test('add returns id and get returns open entry', () => {
    const { dir, file } = tmpFile();
    try {
        const s = makePendingStore(file, { newId: () => 'abc', now: () => new Date('2026-01-01T00:00:00Z') });
        const id = s.add(entry);
        assert.equal(id, 'abc');
        const e = s.get(id);
        assert.equal(e.status, 'open');
        assert.equal(e.id, 'abc');
        assert.equal(e.createdAt, '2026-01-01T00:00:00.000Z');
        assert.equal(e.scheduleTitle, 'T');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('state survives a new store instance; update merges and persists', () => {
    const { dir, file } = tmpFile();
    try {
        const id = makePendingStore(file).add(entry);
        const s2 = makePendingStore(file);
        const u = s2.update(id, { status: 'running', messageId: 'm1' });
        assert.equal(u.status, 'running');
        assert.equal(u.scheduleTitle, 'T');
        assert.equal(makePendingStore(file).get(id).messageId, 'm1');
        assert.equal(makePendingStore(file).list().length, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unknown id is null for get and update', () => {
    const { dir, file } = tmpFile();
    try {
        const s = makePendingStore(file);
        assert.equal(s.get('nope'), null);
        assert.equal(s.update('nope', { status: 'done' }), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt file behaves as empty', () => {
    const { dir, file } = tmpFile();
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{not json');
        const s = makePendingStore(file);
        assert.deepEqual(s.list(), []);
        assert.equal(s.get('x'), null);
        const id = s.add(entry);
        assert.equal(s.get(id).status, 'open');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
