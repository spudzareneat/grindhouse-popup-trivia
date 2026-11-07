import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// Regression: the module-level .finally() once referenced names scoped inside main(), so every
// invocation ended in a ReferenceError (and an exit code of 1) no matter what the command did.
test('cli exits with its own code and no crash from the final cleanup hook (bad usage => 64)', () => {
    const r = spawnSync(process.execPath, [CLI, 'not-a-command'], { encoding: 'utf8' });
    assert.equal(r.status, 64);
    assert.doesNotMatch(r.stderr, /ReferenceError/);
});

test('cleanup hook also survives with PRUNE_CLAUDE_STATE=1', () => {
    const r = spawnSync(process.execPath, [CLI, 'not-a-command'], { encoding: 'utf8', env: { ...process.env, PRUNE_CLAUDE_STATE: '1', HOME: process.env.TEMP || '/tmp' } });
    assert.equal(r.status, 64);
    assert.doesNotMatch(r.stderr, /ReferenceError/);
});
