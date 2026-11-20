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

// `schedule` publishes the lineup only. A dry run never writes, and a scrape failure must exit 1 with its message.
test('schedule is a known command: a failing dry run exits 1 (not the usage code 64) and says why', () => {
    const r = spawnSync(process.execPath, [CLI, 'schedule', '--dry-run'], {
        encoding: 'utf8', env: { ...process.env, REDDIT_COOKIES_FILE: path.join(process.env.TEMP || '/tmp', 'no-such-cookies.json'), DISCORD_BOT_TOKEN: '', PRUNE_CLAUDE_STATE: '' },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /schedule failed: Reddit cookie file not found/);
    assert.doesNotMatch(r.stderr, /ReferenceError/);
});
test('schedule rejects unknown options like the other commands', () => {
    const r = spawnSync(process.execPath, [CLI, 'schedule', '--bogus'], { encoding: 'utf8' });
    assert.equal(r.status, 64);
});
