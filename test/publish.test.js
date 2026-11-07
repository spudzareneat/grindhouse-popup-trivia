import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGit } from '../src/publish.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const recorder = (tracked = []) => {
    const calls = [];
    return { calls, exec: (cmd, args) => { calls.push(args.slice(2)); return args[2] === 'ls-files' && tracked.includes(args[4]) ? args[4] + '\n' : ''; } };
};

test('commitAndPush: without removals the git sequence is add, commit, push', () => {
    const { calls, exec } = recorder();
    makeGit('/repo', { exec }).commitAndPush('data/tt1.json', 'msg');
    assert.deepEqual(calls, [['add', '--', 'data/tt1.json'], ['commit', '-m', 'msg', '--', 'data/tt1.json'], ['push']]);
});

test('commitAndPush: removed files are git rm-ed and committed with the new file', () => {
    const { calls, exec } = recorder(['data/tt0.json']);
    makeGit('/repo', { exec }).commitAndPush('data/tt1.json', 'msg', ['data/tt0.json']);
    assert.deepEqual(calls, [
        ['add', '--', 'data/tt1.json'],
        ['ls-files', '--', 'data/tt0.json'],
        ['rm', '-q', '--ignore-unmatch', '--', 'data/tt0.json'],
        ['commit', '-m', 'msg', '--', 'data/tt1.json', 'data/tt0.json'],
        ['push'],
    ]);
});

test('commitAndPush: dry run does nothing', () => {
    const { calls, exec } = recorder();
    assert.equal(makeGit('/repo', { dryRun: true, exec }).commitAndPush('a', 'm', ['b']), false);
    assert.deepEqual(calls, []);
});

test('commitAndPush: untracked removed paths are skipped', () => {
    const { calls, exec } = recorder();
    makeGit('/repo', { exec }).commitAndPush('data/tt1.json', 'msg', ['data/tt0.json']);
    assert.deepEqual(calls, [
        ['add', '--', 'data/tt1.json'],
        ['ls-files', '--', 'data/tt0.json'],
        ['commit', '-m', 'msg', '--', 'data/tt1.json'],
        ['push'],
    ]);
});

function realRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-git-'));
    const run = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    run('init', '-q');
    run('config', 'user.name', 'T'); run('config', 'user.email', 't@example.com'); run('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'old.json'), '{}\n');
    run('add', '.'); run('commit', '-q', '-m', 'init');
    const exec = (cmd, args, opts) => args[2] === 'push' ? '' : execFileSync(cmd, args, opts);
    return { dir, run, git: makeGit(dir, { exec }) };
}

test('commitAndPush (real git): a tracked removed file is deleted in the same commit', () => {
    const { dir, run, git } = realRepo();
    const nu = path.join(dir, 'new.json');
    fs.writeFileSync(nu, '{}\n');
    git.commitAndPush(nu, 'replace', [path.join(dir, 'old.json')]);
    assert.equal(run('rev-list', '--count', 'HEAD').trim(), '2');
    assert.deepEqual(run('show', '--no-renames', '--name-status', '--format=', 'HEAD').trim().split(/\r?\n/).sort(), ['A\tnew.json', 'D\told.json']);
});

test('commitAndPush (real git): a missing removed file is skipped without error', () => {
    const { dir, run, git } = realRepo();
    const nu = path.join(dir, 'new.json');
    fs.writeFileSync(nu, '{}\n');
    git.commitAndPush(nu, 'add only', [path.join(dir, 'ghost.json')]);
    assert.equal(run('rev-list', '--count', 'HEAD').trim(), '2');
    assert.equal(run('show', '--no-renames', '--name-status', '--format=', 'HEAD').trim(), 'A\tnew.json');
});

test('removeAndPush: git rm-s tracked paths and commits only them; untracked is a no-op', () => {
    const { calls, exec } = recorder(['data/tt0.json']);
    assert.equal(makeGit('/repo', { exec }).removeAndPush(['data/tt0.json'], 'msg'), true);
    assert.deepEqual(calls, [
        ['ls-files', '--', 'data/tt0.json'],
        ['rm', '-q', '--ignore-unmatch', '--', 'data/tt0.json'],
        ['commit', '-m', 'msg', '--', 'data/tt0.json'],
        ['push'],
    ]);
    const none = recorder();
    assert.equal(makeGit('/repo', { exec: none.exec }).removeAndPush(['data/tt0.json'], 'msg'), false);
    assert.deepEqual(none.calls, [['ls-files', '--', 'data/tt0.json']]);
    assert.equal(makeGit('/repo', { dryRun: true, exec: none.exec }).removeAndPush(['x'], 'm'), false);
});
