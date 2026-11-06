// Cross-process lock: serialises cron runs and click-fixes that share one data checkout.
// The lock file holds the owner's pid; it is created exclusively ('wx') so acquisition is race-safe.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readPid(lockFile) {
    try {
        const pid = Number.parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch (e) {
        return e.code === 'ENOENT' ? undefined : null; // undefined: gone; null: unreadable/empty
    }
}

export async function withLock(lockFile, fn, { pollMs = 5000, isAlive = pidAlive, sleep = delay, onWait } = {}) {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    let waited = false;
    for (;;) {
        try {
            fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
            break;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
        }
        const pid = readPid(lockFile);
        if (pid === undefined) continue; // released between our attempts; retry now
        if (pid === null || !isAlive(pid)) {
            // Stale: take over, but only if it is still the same stale lock we inspected.
            if (readPid(lockFile) === pid) fs.rmSync(lockFile, { force: true });
            continue;
        }
        if (!waited) { waited = true; onWait?.(pid); }
        await sleep(pollMs);
    }
    try {
        return await fn();
    } finally {
        fs.rmSync(lockFile, { force: true });
    }
}
