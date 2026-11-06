import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const docPath = (dir, tconst) => path.join(dir, `${tconst}.json`);
export const hasDoc = (dir, tconst) => fs.existsSync(docPath(dir, tconst));

export function writeDoc(dir, doc) {
    fs.mkdirSync(dir, { recursive: true });
    const p = docPath(dir, doc.imdbId);
    fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
    return p;
}

export function makeGit(repoDir, { dryRun = false, exec = execFileSync } = {}) {
    const git = (...args) => exec('git', ['-C', repoDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const pushWithRetry = () => {
        try { git('push'); } catch {
            // Remote moved (e.g. a manual edit on GitHub) -- rebase our one commit and retry once.
            try {
                git('pull', '--rebase', '--autostash');
                git('push');
            } catch (e) {
                try { git('rebase', '--abort'); } catch { /* no rebase in progress */ }
                throw e;
            }
        }
    };
    // Only tracked files can be removed in a commit; an unknown id is silently skipped.
    const trackedOf = paths => paths.filter(p => String(git('ls-files', '--', p) ?? '').trim() !== '');
    return {
        pull() { if (!dryRun) git('pull', '--rebase', '--autostash'); },
        // Delivers commits stranded by an earlier failed push; fails fast on a read-only deploy key.
        push() { if (!dryRun) git('push'); },
        commitAndPush(filePath, message, removePaths = []) {
            if (dryRun) return false;
            git('add', '--', filePath);
            const tracked = trackedOf(removePaths);
            for (const p of tracked) git('rm', '-q', '--ignore-unmatch', '--', p);
            git('commit', '-m', message, '--', filePath, ...tracked);
            pushWithRetry();
            return true;
        },
        // Removal-only commit (nothing to add). Returns true if something was removed, false if no path was tracked.
        removeAndPush(paths, message) {
            if (dryRun) return false;
            const tracked = trackedOf(paths);
            if (!tracked.length) return false;
            for (const p of tracked) git('rm', '-q', '--ignore-unmatch', '--', p);
            git('commit', '-m', message, '--', ...tracked);
            pushWithRetry();
            return true;
        },
    };
}
