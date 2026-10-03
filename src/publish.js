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
    return {
        pull() { if (!dryRun) git('pull', '--rebase', '--autostash'); },
        // Delivers commits stranded by an earlier failed push; fails fast on a read-only deploy key.
        push() { if (!dryRun) git('push'); },
        commitAndPush(filePath, message) {
            if (dryRun) return false;
            git('add', '--', filePath);
            git('commit', '-m', message, '--', filePath);
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
            return true;
        },
    };
}
