import { buildPrompt } from './prompt.js';
import { MODEL_OUTPUT_SCHEMA, MIN_FACTS } from './schema.js';
import { validateFacts, buildDoc } from './validate.js';
import { findTotals } from './driveintotals.js';
import { hasDoc, writeDoc } from './publish.js';

export class UsageLimitError extends Error {}
export class PublishError extends Error {}

const soft = async (p) => { try { return await p; } catch { return null; } };

async function resolveTconst(item, imdb) {
    if (item.tconst) return item.tconst;
    for (const title of [item.title, ...(item.akas || [])]) {
        const m = await imdb.searchTitle(title, item.year ?? null);
        if (m) return m.tconst;
    }
    return null;
}

export async function processMovie(item, deps) {
    const { imdb, wiki, tmdb, totalsRows, runClaude, model, dataDir, outDir, git, force, dryRun, log, now } = deps;
    const label = item.title ? `${item.title}${item.year ? ` (${item.year})` : ''}` : item.tconst;
    const tconst = await resolveTconst(item, imdb);
    if (!tconst) return { status: 'failed', title: label, reason: 'not found on IMDb' };
    if (!force && hasDoc(dataDir, tconst)) return { status: 'skipped', title: label, tconst, reason: 'already has a file' };

    const bundle = await imdb.fetchBundle(tconst);
    if (bundle.isSeries || bundle.isEpisode) return { status: 'skipped', title: label, tconst, reason: 'TV series/episode' };

    const wikidata = await soft(wiki.fetchWikidata(tconst));
    const [wikipedia, tmdbExtras] = await Promise.all([
        wikidata?.wikipediaTitle ? soft(wiki.fetchWikipediaExtract(wikidata.wikipediaTitle)) : null,
        soft(tmdb.fetchExtras(tconst)),
    ]);
    const totals = findTotals(totalsRows, bundle.title, bundle.year) ?? (item.title ? findTotals(totalsRows, item.title, item.year ?? null) : null);
    const prompt = buildPrompt({ imdb: bundle, wikidata, wikipedia, totals, tmdb: tmdbExtras });
    const peopleImages = Object.fromEntries((bundle.people || []).map(p => [p.nconst, p.image || null]));
    log(`  researching ${bundle.title} (${bundle.year}) ${tconst} — totals: ${totals ? 'yes' : 'no'}, wikipedia: ${wikipedia ? 'yes' : 'no'}`);

    let best = { facts: [], dropped: {} };
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const r = await runClaude(prompt, { model, schema: MODEL_OUTPUT_SCHEMA });
        if (r.usageLimited) throw Object.assign(new UsageLimitError(r.error || 'usage limit'), { authError: !!r.authError });
        if (!r.ok) { lastError = r.error; log(`  attempt ${attempt} failed: ${r.error}`); continue; }
        lastError = null;
        const v = validateFacts(r.facts, bundle.runtimeSec, peopleImages);
        log(`  attempt ${attempt}: ${r.facts.length} facts from model, ${v.facts.length} kept, dropped ${JSON.stringify(v.dropped)}${r.costUsd != null ? `, $${r.costUsd.toFixed(2)} equiv` : ''}${r.numTurns != null ? `, ${r.numTurns} turns` : ''}`);
        if (v.facts.length > best.facts.length) best = v;
        if (v.facts.length >= MIN_FACTS) break;
    }
    if (best.facts.length < MIN_FACTS) {
        return { status: 'failed', title: label, tconst, reason: lastError || `only ${best.facts.length} valid facts` };
    }

    const doc = buildDoc({ imdbId: tconst, title: bundle.title, year: bundle.year, runtimeSec: bundle.runtimeSec, facts: best.facts, generatedAt: now() });
    const file = writeDoc(dryRun ? outDir : dataDir, doc);
    if (!dryRun) {
        try {
            git.commitAndPush(file, `data: ${bundle.title} (${bundle.year}) — ${best.facts.length} facts\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
        } catch (e) {
            throw new PublishError(e.message);
        }
    }
    return { status: 'done', title: label, tconst, kept: best.facts.length, dropped: best.dropped };
}

export async function runWeekend(deps, { fetchWeekend, delayMs, sleep }) {
    deps.git.pull();
    deps.git.push();   // deliver commits stranded by an earlier failed push; fail fast (before any Claude usage) on a read-only key
    const { postTitle, movies, weekendFri } = await fetchWeekend();
    deps.log(`Schedule: ${postTitle}${weekendFri ? ` (Fri ${weekendFri})` : ''} — ${movies.length} movies`);
    if (weekendFri) {
        const today = deps.now().slice(0, 10);
        const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 86400000).toISOString().slice(0, 10);
        if (weekendFri < cutoff) deps.log(`  WARNING: schedule post looks stale (Fri ${weekendFri}) — new post may not be up yet`);
    }
    const results = [];
    for (let i = 0; i < movies.length; i++) {
        const m = movies[i];
        deps.log(`[${i + 1}/${movies.length}] ${m.title}${m.year ? ` (${m.year})` : ''}`);
        let r;
        try {
            r = await processMovie(m, deps);
        } catch (e) {
            if (e instanceof UsageLimitError) {
                const what = e.authError ? 'Claude auth failed' : 'usage limit';
                results.push({ status: 'failed', title: m.title, stop: 'usage', reason: `${what} — run stopped (${e.message})` });
                deps.log(e.authError
                    ? '  Claude authentication failed (check CLAUDE_CODE_OAUTH_TOKEN) — stopping this run; finished movies are already pushed.'
                    : '  Claude usage limit hit — stopping this run; finished movies are already pushed.');
                break;
            }
            if (e instanceof PublishError) {
                results.push({ status: 'failed', title: m.title, stop: 'publish', reason: `git push failed — run stopped (${e.message})` });
                deps.log('  git push failed — stopping this run so no more research is wasted; the commit stays local and is pushed next run.');
                break;
            }
            r = { status: 'failed', title: m.title, reason: e.message };
        }
        results.push(r);
        deps.log(`  -> ${r.status}${r.reason ? `: ${r.reason}` : ''}`);
        if (r.status === 'done' && i < movies.length - 1) await sleep(delayMs);
    }
    deps.log(summarize(results));
    return results;
}

export function summarize(results) {
    const c = s => results.filter(r => r.status === s).length;
    const lines = results.map(r => `  ${r.status.padEnd(7)} ${r.title}${r.kept ? ` — ${r.kept} facts` : ''}${r.reason ? ` — ${r.reason}` : ''}`);
    return `Summary: ${c('done')} done, ${c('skipped')} skipped, ${c('failed')} failed\n${lines.join('\n')}`;
}
