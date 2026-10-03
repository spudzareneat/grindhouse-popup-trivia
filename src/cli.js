#!/usr/bin/env node
// Usage:
//   node src/cli.js run [--dry-run] [--force]
//   node src/cli.js movie <tt1234567 | "Title"> [--year 1962] [--dry-run] [--force]
// Env: DATA_REPO_DIR (git checkout to write data/ into; default cwd), CLAUDE_MODEL (default "sonnet"),
//      TMDB_API_KEY (optional), MOVIE_DELAY_SEC (default 60), CLAUDE_TIMEOUT_MIN (default 30).
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchWeekendMovies } from './schedule.js';
import { makeImdb } from './imdb.js';
import { makeWiki } from './wiki.js';
import { makeTmdb } from './tmdb.js';
import { fetchTotals } from './driveintotals.js';
import { runClaude } from './claude.js';
import { makeGit } from './publish.js';
import { processMovie, runWeekend, UsageLimitError } from './pipeline.js';

function parseArgs(argv) {
    const args = { _: [], dryRun: false, force: false, year: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--force') args.force = true;
        else if (a === '--year') args.year = Number(argv[++i]);
        else args._.push(a);
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const [command, target] = args._;
    if (!(command === 'run' || (command === 'movie' && target))) {
        console.error('usage: cli.js run [--dry-run] [--force] | cli.js movie <tt…|"Title"> [--year N] [--dry-run] [--force]');
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
        process.exitCode = results.some(r => /usage limit/.test(r.reason || '')) ? 2 : 0;
    } else {
        const item = /^tt\d+$/.test(target) ? { tconst: target } : { title: target, year: args.year, akas: [] };
        try {
            const r = await processMovie(item, deps);
            log(`${r.status}${r.reason ? `: ${r.reason}` : ''}${r.kept ? ` — ${r.kept} facts` : ''}`);
            process.exitCode = r.status === 'failed' ? 1 : 0;
        } catch (e) {
            log(e instanceof UsageLimitError ? `usage limit: ${e.message}` : e.stack);
            process.exitCode = e instanceof UsageLimitError ? 2 : 1;
        }
    }
}

main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
