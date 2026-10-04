#!/usr/bin/env node
// Usage:
//   node src/cli.js run [--dry-run] [--force]
//   node src/cli.js movie <tt1234567 | "Title"> [--year 1962] [--dry-run] [--force]
// Env: DATA_REPO_DIR (git checkout to write data/ into; default cwd), CLAUDE_MODEL (default "sonnet"),
//      TMDB_API_KEY (optional), OPENSUBTITLES_API_KEY [+ _USERNAME/_PASSWORD] (optional, scene timing),
//      MOVIE_DELAY_SEC (default 60), CLAUDE_TIMEOUT_MIN (default 30),
//      PRUNE_CLAUDE_STATE=1 (container only: clear the Claude CLI's scratch folders after each run).
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchWeekendMovies } from './schedule.js';
import { makeImdb } from './imdb.js';
import { makeWiki } from './wiki.js';
import { makeTmdb } from './tmdb.js';
import { makeSubtitles } from './subtitles.js';
import { fetchTotals } from './driveintotals.js';
import { runClaude, pruneClaudeState } from './claude.js';
import { makeGit } from './publish.js';
import { processMovie, runWeekend, UsageLimitError, PublishError } from './pipeline.js';
import { parseArgs, USAGE } from './args.js';

// Exit codes: 0 ok, 1 failures / feed error, 2 Claude usage limit or auth, 3 git push failed, 64 bad usage.
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const [command, target] = args._;
    if (args.error || !(command === 'run' || (command === 'movie' && target))) {
        console.error(USAGE);
        if (args.error) console.error(args.error);
        process.exitCode = 64;
        return;
    }
    const repoDir = path.resolve(process.env.DATA_REPO_DIR || process.cwd());
    const timeoutMs = Number(process.env.CLAUDE_TIMEOUT_MIN || 30) * 60 * 1000;
    const log = (...m) => console.log(new Date().toISOString(), ...m);
    const deps = {
        imdb: makeImdb(),
        wiki: makeWiki(),
        tmdb: makeTmdb(process.env.TMDB_API_KEY || ''),
        subtitles: process.env.OPENSUBTITLES_API_KEY ? makeSubtitles({
            apiKey: process.env.OPENSUBTITLES_API_KEY, username: process.env.OPENSUBTITLES_USERNAME, password: process.env.OPENSUBTITLES_PASSWORD,
            cacheDir: path.join(repoDir, '.cache', 'subtitles'),
        }) : null,
        totalsRows: await fetchTotals().catch(e => { log(`Drive-In Totals unavailable: ${e.message}`); return []; }),
        runClaude: (prompt, opts) => runClaude(prompt, { ...opts, timeoutMs }),
        model: process.env.CLAUDE_MODEL || 'sonnet',
        dataDir: path.join(repoDir, 'data'),
        outDir: path.join(repoDir, 'out'),
        git: makeGit(repoDir, { dryRun: args.dryRun }),
        force: args.force,
        dryRun: args.dryRun,
        log,
        now: () => new Date().toISOString(),
    };

    if (command === 'run') {
        const results = await runWeekend(deps, {
            fetchWeekend: () => fetchWeekendMovies(),
            delayMs: Number(process.env.MOVIE_DELAY_SEC || 60) * 1000,
            sleep,
        });
        const attempted = results.filter(r => r.status !== 'skipped');
        if (results.some(r => r.stop === 'publish')) process.exitCode = 3;
        else if (results.some(r => r.stop === 'usage')) process.exitCode = 2;
        else if (attempted.length && attempted.every(r => r.status === 'failed')) process.exitCode = 1;
        else process.exitCode = 0;
    } else {
        const item = /^tt\d+$/.test(target) ? { tconst: target } : { title: target, year: args.year, akas: [] };
        try {
            deps.git.pull();
            deps.git.push();
            const r = await processMovie(item, deps);
            log(`${r.status}${r.reason ? `: ${r.reason}` : ''}${r.kept ? ` — ${r.kept} facts` : ''}`);
            process.exitCode = r.stop === 'usage' ? 2 : r.status === 'failed' ? 1 : 0;
        } catch (e) {
            if (e instanceof UsageLimitError) { log(`${e.authError ? 'Claude auth failed' : 'usage limit'}: ${e.message}`); process.exitCode = 2; }
            else if (e instanceof PublishError) { log(`git push failed: ${e.message}`); process.exitCode = 3; }
            else { log(e.stack); process.exitCode = 1; }
        }
    }
}

main().catch(e => { console.error(e.stack || e); process.exitCode = 1; })
    // Container only: the CLI's scratch state would otherwise grow in the container layer forever.
    .finally(() => { if (process.env.PRUNE_CLAUDE_STATE === '1') pruneClaudeState(); });
