import { titleVariants, titleSimilarity, titlesMatch } from './titles.js';
import { overrideKey } from './overrides.js';

export const SIMILARITY_STRONG = 0.85;
export const LEAD_RATIO = 0.5;
const MAX_CANDIDATES = 5;

const yearNear = (a, b) => a != null && b != null && Math.abs(a - b) <= 1;
const byVotes = (a, b) => (b.votes ?? 0) - (a.votes ?? 0);

// scheduleTitle is the search term that produced the match (the item's title, an alias or a variant).
export function rateMatch({ scheduleTitle, scheduleYear, matched, pool = [] }) {
  if (scheduleYear == null) return 'unsure';
  if (titleSimilarity(scheduleTitle, matched.title) < SIMILARITY_STRONG) return 'unsure';
  const votes = matched.votes ?? 0;
  const rival = pool.some(c => c.tconst !== matched.tconst
    && titlesMatch(scheduleTitle, c.title)
    && yearNear(c.year, scheduleYear)
    && (c.votes ?? 0) >= LEAD_RATIO * votes);
  return rival ? 'unsure' : 'confident';
}

export async function resolveTitle(item, { imdb, tmdb, overrides, log } = {}) {
  const year = item.year ?? null;
  const res = (tconst, source, confidence, extra = {}) => ({
    tconst, source, confidence, matchedTitle: null, matchedYear: null, candidates: [], tried: [], ...extra,
  });
  if (item.tconst) return res(item.tconst, 'direct', 'confident');
  const picked = item.title ? overrides?.picks?.[overrideKey(item.title, year)] : null;
  if (picked) return res(picked, 'override', 'confident');

  // Term order moved unchanged from pipeline.resolveTconst: names, then variants of each, de-duplicated.
  const names = [item.title, ...(item.akas || [])].filter(Boolean);
  const terms = [];
  for (const t of [...names, ...names.flatMap(titleVariants)]) if (!terms.includes(t)) terms.push(t);

  // Never throws: a failure is logged and reported so callers can decide how to treat it.
  const cache = new Map();
  const search = (svc, key, term) => {
    const k = `${key}:${term}`;
    if (!cache.has(k)) {
      cache.set(k, (async () => (await svc?.searchCandidates?.(term)) || [])().then(
        r => ({ items: r.filter(c => c && c.tconst), failed: false }),
        e => { log?.(`  ${key} candidate search for "${term}" failed: ${e?.message ?? e}`); return { items: [], failed: true }; },
      ));
    }
    return cache.get(k);
  };

  const gather = async () => {
    const seen = new Map();
    for (const term of terms.slice(0, 2)) {
      for (const c of [...(await search(imdb, 'imdb', term)).items, ...(await search(tmdb, 'tmdb', term)).items]) {
        if (!seen.has(c.tconst)) seen.set(c.tconst, c);
      }
    }
    const base = item.title || terms[0] || '';
    return [...seen.values()]
      .sort((a, b) => titleSimilarity(base, b.title) - titleSimilarity(base, a.title) || byVotes(a, b))
      .slice(0, MAX_CANDIDATES);
  };

  for (const term of terms) {
    const m = await imdb.searchTitle(term, year);
    if (!m) continue;
    if (!names.includes(term)) log?.(`  matched on IMDb as "${term}" -> ${m.title} (${m.year})`);
    const found = year == null ? { items: [], failed: false } : await search(imdb, 'imdb', term);
    const pool = found.items;
    const known = pool.find(c => c.tconst === m.tconst);
    const matched = { tconst: m.tconst, title: m.title, year: m.year ?? null, votes: m.votes ?? known?.votes ?? 0, source: 'imdb' };
    const confidence = found.failed ? 'unsure' : rateMatch({ scheduleTitle: term, scheduleYear: year, matched, pool });
    return res(m.tconst, 'imdb', confidence, {
      matchedTitle: m.title, matchedYear: m.year ?? null, tried: terms,
      candidates: confidence === 'unsure' ? await gather() : [],
    });
  }

  for (const term of terms) {
    const hits = (await search(tmdb, 'tmdb', term)).items
      .filter(c => titlesMatch(term, c.title) && (year == null || yearNear(c.year, year)))
      .sort(byVotes);
    if (!hits.length) continue;
    const matched = hits[0];
    const confidence = rateMatch({ scheduleTitle: term, scheduleYear: year, matched, pool: hits });
    return res(matched.tconst, 'tmdb', confidence, {
      matchedTitle: matched.title, matchedYear: matched.year ?? null, tried: terms,
      candidates: confidence === 'unsure' ? await gather() : [],
    });
  }

  return res(null, null, 'none', { tried: terms, candidates: await gather() });
}
