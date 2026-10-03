import { buildPrompt } from './prompt.js';
import { MODEL_OUTPUT_SCHEMA, MIN_FACTS } from './schema.js';
import { validateFacts, buildDoc } from './validate.js';
import { findTotals } from './driveintotals.js';
import { hasDoc, writeDoc } from './publish.js';

export class UsageLimitError extends Error {}

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
    log(`  researching ${bundle.title} (${bundle.year}) ${tconst} — totals: ${totals ? 'yes' : 'no'}, wikipedia: ${wikipedia ? 'yes' : 'no'}`);

    let best = { facts: [], dropped: {} };
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const r = await runClaude(prompt, { model, schema: MODEL_OUTPUT_SCHEMA });
        if (r.usageLimited) throw new UsageLimitError(r.error || 'usage limit');
        if (!r.ok) { lastError = r.error; log(`  attempt ${attempt} failed: ${r.error}`); continue; }
        const v = validateFacts(r.facts, bundle.runtimeSec);
        log(`  attempt ${attempt}: ${r.facts.length} facts from model, ${v.facts.length} kept, dropped ${JSON.stringify(v.dropped)}${r.costUsd != null ? `, $${r.costUsd.toFixed(2)} equiv` : ''}`);
        if (v.facts.length > best.facts.length) best = v;
        if (v.facts.length >= MIN_FACTS) break;
    }
    if (best.facts.length < MIN_FACTS) {
        return { status: 'failed', title: label, tconst, reason: lastError || `only ${best.facts.length} valid facts` };
    }

    const doc = buildDoc({ imdbId: tconst, title: bundle.title, year: bundle.year, runtimeSec: bundle.runtimeSec, facts: best.facts, generatedAt: now() });
    const file = writeDoc(dryRun ? outDir : dataDir, doc);
    if (!dryRun) {
        git.commitAndPush(file, `data: ${bundle.title} (${bundle.year}) — ${best.facts.length} facts\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
    }
    return { status: 'done', title: label, tconst, kept: best.facts.length, dropped: best.dropped };
}

export async function runWeekend(deps, { fetchWeekend, delayMs, sleep }) {
    deps.git.pull();
    const { postTitle, movies } = await fetchWeekend();
    deps.log(`Schedule: ${postTitle} — ${movies.length} movies`);
    const results = [];
    for (let i = 0; i < movies.length; i++) {
        const m = movies[i];
        deps.log(`[${i + 1}/${movies.length}] ${m.title}${m.year ? ` (${m.year})` : ''}`);
        let r;
        try {
            r = await processMovie(m, deps);
        } catch (e) {
            if (e instanceof UsageLimitError) {
                results.push({ status: 'failed', title: m.title, reason: `usage limit — run stopped (${e.message})` });
                deps.log('  Claude usage limit hit — stopping this run; finished movies are already pushed.');
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
