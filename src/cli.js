#!/usr/bin/env node
// Usage:
//   node src/cli.js run [--dry-run] [--force] [--schedule feed.xml | --movies "Title (Year); ..."]   (--movies: typed lineup, skips Reddit; --schedule: saved copy of an old RSS feed, skips the fetch; Reddit RSS ended 2026-11-13)
//   node src/cli.js movie <tt1234567 | "Title"> [--year 1962] [--dry-run] [--force]
//   node src/cli.js backfill-totals [--dry-run] [--force]   (add the Drive-In Totals card to published files)
// Env: DATA_REPO_DIR (git checkout to write data/ into; default cwd), CLAUDE_MODEL (default "sonnet"),
//      TMDB_API_KEY (optional), OPENSUBTITLES_API_KEY [+ _USERNAME/_PASSWORD] (optional, scene timing),
//      MOVIE_DELAY_SEC (default 60), CLAUDE_TIMEOUT_MIN (default 30),
//      PRUNE_CLAUDE_STATE=1 (container only: clear the Claude CLI's scratch folders after each run),
//      DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID (both required to post a run summary and match pickers to Discord).
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readWeekendMoviesFile, parseMoviesList } from './schedule.js';
import { fetchWeekendMoviesViaBrowser, sessionExpiresAt } from './reddit-browser.js';
import { makeImdb } from './imdb.js';
import { makeWiki } from './wiki.js';
import { makeTmdb } from './tmdb.js';
import { makeSubtitles } from './subtitles.js';
import { fetchTotals } from './driveintotals.js';
import { runClaude, pruneClaudeState } from './claude.js';
import { makeGit } from './publish.js';
import { processMovie, runWeekend, UsageLimitError, PublishError } from './pipeline.js';
import { runBackfill } from './backfill.js';
import { parseArgs, USAGE } from './args.js';
import { withLock } from './lock.js';
import { makeDiscordApi } from './discord/api.js';
import { makePendingStore } from './discord/pending.js';
import { notifyRun, notifyFailure, notifySessionExpiring } from './discord/notify.js';
import { loadOverrides } from './overrides.js';
import { publishSchedule, buildScheduleDoc, makeResolveItem, publishBestEffort } from './schedule-doc.js';
import { makeFetchInfo } from './lineup-info.js';
import { fetchKillCounts } from './killcounts.js';

// Exit codes: 0 ok, 1 failures / feed error, 2 Claude usage limit or auth, 3 git push failed, 64 bad usage.
async function main() {
    const args = parseArgs(process.argv.slice(2));
    const [command, target] = args._;
    if (args.error || !(command === 'run' || command === 'schedule' || command === 'backfill-totals' || (command === 'movie' && target))) {
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
        // Only backfill-totals reads the Drive-In Totals CSV; the generator no longer looks films up in it.
        totalsRows: command === 'backfill-totals' ? await fetchTotals().catch(e => { log(`Drive-In Totals unavailable: ${e.message}`); return []; }) : [],
        runClaude: (prompt, opts) => runClaude(prompt, { ...opts, timeoutMs }),
        model: process.env.CLAUDE_MODEL || 'sonnet',
        dataDir: path.join(repoDir, 'data'),
        overridesFile: path.join(repoDir, 'overrides', 'title-overrides.json'),
        outDir: path.join(repoDir, 'out'),
        git: makeGit(repoDir, { dryRun: args.dryRun }),
        force: args.force,
        replaces: args.replaces,
        dryRun: args.dryRun,
        log,
        now: () => new Date().toISOString(),
    };

    // run and movie share one checkout, so they take turns; dry runs and backfill-totals do not touch it.
    // The Claude CLI's scratch state is cleared while we still hold the lock, so a waiting holder never loses its folders.
    const locked = fn => args.dryRun ? fn() : withLock(path.join(repoDir, '.cache', 'run.lock'), async () => {
        try { return await fn(); } finally { prune(); }
    }, {
        onWait: pid => log(`waiting for another run to finish (pid ${pid})...`),
    });

    const discordOn = process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID;
    const makeApi = () => makeDiscordApi({ token: process.env.DISCORD_BOT_TOKEN, channelId: process.env.DISCORD_CHANNEL_ID });
    // Renewal reminder for the Reddit login, sent before the fetch so it still arrives when the fetch fails. Never blocks the run.
    const remindSessionExpiry = async () => {
        if (!discordOn) return;
        try {
            const cookiesFile = process.env.REDDIT_COOKIES_FILE || '/secrets/reddit_cookies.json';
            await notifySessionExpiring({ api: makeApi(), expiresAt: sessionExpiresAt(cookiesFile), markerFile: path.join(repoDir, '.cache', 'reddit-session-warned'), log });
        } catch (e) { log(`Reddit session expiry check skipped: ${e.message}`); }
    };
    // Publishing schedule/current.json (see docs/superpowers/specs/2026-11-20-published-schedule-design.md).
    const resolveItem = makeResolveItem({ imdb: deps.imdb, tmdb: deps.tmdb, overridesFile: deps.overridesFile, log });
    const rate = id => deps.imdb.fetchRating(id);
    // The per-film info shown on Coming Attractions cards (IMDb + TMDB + Wikipedia + kill counts), fetched once here for everyone.
    const fetchInfo = makeFetchInfo({ imdb: deps.imdb, tmdb: deps.tmdb, wiki: deps.wiki, killCounts: () => fetchKillCounts() });
    const publish = fetchPost => publishSchedule({ repoDir, git: deps.git, fetchPost, resolveItem, rate, fetchInfo, now: new Date().toISOString(), log });

    if (command === 'run') {
        let postTitle = null;
        const results = await locked(async () => {
            let res;
            if (!args.dryRun && !args.movies && !args.schedule) await remindSessionExpiry();
            try {
                res = await runWeekend(deps, {
                    // The lineup is published from the scrape this run already makes (no second Reddit login), before any researching.
                    fetchWeekend: async () => {
                        const s = args.movies ? parseMoviesList(args.movies) : args.schedule ? readWeekendMoviesFile(path.resolve(args.schedule)) : await fetchWeekendMoviesViaBrowser({ log });
                        await publishBestEffort({ skip: args.dryRun || !!args.movies || !!args.schedule, post: s.post, publish, log });
                        postTitle = s.postTitle;
                        return s;
                    },
                    delayMs: Number(process.env.MOVIE_DELAY_SEC || 60) * 1000,
                    sleep,
                });
            } catch (e) {
                if (discordOn && !args.dryRun) await notifyFailure({ api: makeApi(), error: e, log });
                throw e;
            }
            if (discordOn && !args.dryRun) {
                try {
                    await notifyRun({
                        api: makeApi(),
                        store: makePendingStore(path.join(repoDir, '.cache', 'discord-pending.json')),
                        results: res, postTitle, log,
                        dismissed: loadOverrides(deps.overridesFile).dismissed,   // read now: the run's git pull may have brought new ones
                        dataDir: deps.dataDir,
                    });
                } catch (e) { log(`Discord notify failed: ${e.message}`); }
            }
            return res;
        });
        const attempted = results.filter(r => r.status !== 'skipped');
        if (results.some(r => r.stop === 'publish')) process.exitCode = 3;
        else if (results.some(r => r.stop === 'usage')) process.exitCode = 2;
        else if (attempted.length && attempted.every(r => r.status === 'failed')) process.exitCode = 1;
        else process.exitCode = 0;
    } else if (command === 'schedule') {
        // Lineup only: scrape, resolve ids, rate, publish. No Claude usage; safe to run often.
        const fetchPost = async () => (await fetchWeekendMoviesViaBrowser({ log })).post;
        try {
            if (!args.dryRun) await remindSessionExpiry();
            if (args.dryRun) {
                const doc = await buildScheduleDoc({ post: await fetchPost(), resolveItem, rate, fetchInfo, now: new Date().toISOString() });
                log(`schedule (dry run, nothing written): ${doc.title}`);
                console.log(JSON.stringify(doc, null, 2));
            } else {
                await locked(() => publish(fetchPost));
            }
            process.exitCode = 0;
        } catch (e) {
            log(`schedule failed: ${e.message}`);
            if (discordOn && !args.dryRun) await notifyFailure({ api: makeApi(), error: e, log });
            process.exitCode = e instanceof PublishError ? 3 : 1;
        }
    } else if (command === 'backfill-totals') {
        if (!deps.totalsRows.length) { log('No Drive-In Totals loaded — nothing to backfill'); process.exitCode = 1; return; }
        try {
            deps.git.pull();
            const results = runBackfill(deps);
            log(`backfill-totals: ${results.length} file(s) updated${args.dryRun ? ' (dry run, written to out/)' : ''}`);
            process.exitCode = 0;
        } catch (e) {
            log(`backfill-totals failed: ${e.message}`);
            process.exitCode = 1;
        }
    } else {
        const item = /^tt\d+$/.test(target) ? { tconst: target } : { title: target, year: args.year, akas: [] };
        try {
            const r = await locked(async () => {
                deps.git.pull();
                deps.git.push();
                return processMovie(item, deps);
            });
            log(`${r.status}${r.reason ? `: ${r.reason}` : ''}${r.kept ? ` — ${r.kept} facts` : ''}${r.removed ? ` — removed ${r.removed}` : ''}`);
            process.exitCode = r.stop === 'usage' ? 2 : r.status === 'failed' ? 1 : 0;
        } catch (e) {
            if (e instanceof UsageLimitError) { log(`${e.authError ? 'Claude auth failed' : 'usage limit'}: ${e.message}`); process.exitCode = 2; }
            else if (e instanceof PublishError) { log(`git push failed: ${e.message}`); process.exitCode = 3; }
            else { log(e.stack); process.exitCode = 1; }
        }
    }
}

// Module scope on purpose: the final .finally() below must see these even when main() returns early.
let pruned = false;
const prune = () => { if (process.env.PRUNE_CLAUDE_STATE === '1') { pruned = true; pruneClaudeState(); } };

main().catch(e => { console.error(e.stack || e); process.exitCode = 1; })
    // Container only: the CLI's scratch state would otherwise grow in the container layer forever.
    .finally(() => { if (!pruned) prune(); });
