import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGit } from '../src/publish.js';

const recorder = () => {
    const calls = [];
    return { calls, exec: (cmd, args) => { calls.push(args.slice(2)); return ''; } };
};

test('commitAndPush: without removals the git sequence is add, commit, push', () => {
    const { calls, exec } = recorder();
    makeGit('/repo', { exec }).commitAndPush('data/tt1.json', 'msg');
    assert.deepEqual(calls, [['add', '--', 'data/tt1.json'], ['commit', '-m', 'msg', '--', 'data/tt1.json'], ['push']]);
});

test('commitAndPush: removed files are git rm-ed and committed with the new file', () => {
    const { calls, exec } = recorder();
    makeGit('/repo', { exec }).commitAndPush('data/tt1.json', 'msg', ['data/tt0.json']);
    assert.deepEqual(calls, [
        ['add', '--', 'data/tt1.json'],
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
