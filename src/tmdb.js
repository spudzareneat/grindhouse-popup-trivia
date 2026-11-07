import { getJson } from './http.js';

const BASE = 'https://api.themoviedb.org/3';

// Optional source. TMDB v3 API key via TMDB_API_KEY; without one this is a no-op.
export function makeTmdb(apiKey, fetchImpl = fetch) {
    if (!apiKey) return { fetchExtras: async () => null, searchCandidates: async () => [] };
    const k = `api_key=${encodeURIComponent(apiKey)}`;
    async function fetchExtras(tconst) {
        const find = await getJson(fetchImpl, `${BASE}/find/${tconst}?external_source=imdb_id&${k}`);
        const m = find.movie_results?.[0];
        if (!m) return null;
        const [kw, det] = await Promise.all([
            getJson(fetchImpl, `${BASE}/movie/${m.id}/keywords?${k}`),
            getJson(fetchImpl, `${BASE}/movie/${m.id}?${k}`),
        ]);
        return {
            keywords: (kw.keywords || []).map(x => x.name).slice(0, 30),
            collection: det.belongs_to_collection?.name ?? null,
            tagline: det.tagline || null,
            budget: det.budget || null,
            revenue: det.revenue || null,
        };
    }

    // Title search for the picker; only hits with an IMDb id are usable. Never throws.
    // With a year, TMDB is first asked for films released that year (a common title like "Seven" buries the
    // 1979 film under dozens of others otherwise), then for the plain search so a year that is off by one
    // still turns up. Each search contributes at most 5 hits; a film found by both is looked up once.
    async function searchCandidates(term, year = null) {
        try {
            const search = async (extra) => {
                try { return ((await getJson(fetchImpl, `${BASE}/search/movie?query=${encodeURIComponent(term)}${extra}&${k}`)).results || []).slice(0, 5); }
                catch (e) { if (extra) return []; throw e; }
            };
            const byYear = year ? await search(`&year=${encodeURIComponent(year)}`) : [];
            const plain = await search('');
            const hits = [...new Map([...byYear, ...plain].map(h => [h.id, h])).values()];
            const out = await Promise.all(hits.map(async h => {
                try {
                    const ext = await getJson(fetchImpl, `${BASE}/movie/${h.id}/external_ids?${k}`);
                    if (!ext.imdb_id) return null;
                    const y = parseInt((h.release_date || '').slice(0, 4), 10);
                    return { tconst: ext.imdb_id, title: h.title ?? '', year: Number.isFinite(y) ? y : null, votes: h.vote_count ?? 0, source: 'tmdb' };
                } catch { return null; }
            }));
            return out.filter(Boolean);
        } catch { return []; }
    }
    return { fetchExtras, searchCandidates };
}
