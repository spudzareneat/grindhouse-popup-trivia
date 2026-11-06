// Cross-process lock: serialises cron runs and click-fixes that share one data checkout.
// The lock file holds the owner's pid. It is published with content already in place (write a temp file,
// then hard-link it to the lock name, which fails with EEXIST if held), so readers never see a half-made lock.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const uniq = () => `${process.pid}.${crypto.randomBytes(4).toString('hex')}`;

// -> { gone: true } | { pid: number|null, mtimeMs }   (pid null: empty/unreadable content)
function inspect(file) {
    try {
        const text = fs.readFileSync(file, 'utf8').trim();
        const mtimeMs = fs.statSync(file).mtimeMs;
        const pid = Number.parseInt(text, 10);
        return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, mtimeMs };
    } catch (e) {
        if (e.code === 'ENOENT') return { gone: true };
        return { pid: null, mtimeMs: 0 };
    }
}

// Try to create the lock atomically with the pid inside. Returns true if we now hold it.
function tryCreate(lockFile) {
    const tmp = `${lockFile}.${uniq()}.tmp`;
    try {
        fs.writeFileSync(tmp, String(process.pid), { flag: 'wx' });
        fs.linkSync(tmp, lockFile);
        return true;
    } catch (e) {
        if (e.code === 'EEXIST') return false;
        throw e;
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

export async function withLock(lockFile, fn, { pollMs = 5000, isAlive = pidAlive, sleep = delay, onWait, emptyStaleMs = 2000 } = {}) {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const isStale = info => info.pid === null ? Date.now() - info.mtimeMs > emptyStaleMs : !isAlive(info.pid);
    let waited = false;
    while (!tryCreate(lockFile)) {
        const info = inspect(lockFile);
        if (info.gone) continue;
        if (isStale(info)) {
            // Only one process can rename the stale file away; the loser sees ENOENT and retries.
            const aside = `${lockFile}.stale.${uniq()}`;
            try { fs.renameSync(lockFile, aside); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
            const got = inspect(aside);
            if (got.gone || isStale(got)) { fs.rmSync(aside, { force: true }); continue; }
            // We raced and moved a live lock: put it back (link fails if a new lock already exists).
            try { fs.linkSync(aside, lockFile); } catch { /* a newer lock exists; nothing more to restore */ }
            fs.rmSync(aside, { force: true });
        }
        if (!waited) { waited = true; onWait?.(info.pid); }
        await sleep(pollMs);
    }
    try {
        return await fn();
    } finally {
        // Only remove the lock if it is still ours; it may have been taken over meanwhile.
        if (inspect(lockFile).pid === process.pid) fs.rmSync(lockFile, { force: true });
    }
}
