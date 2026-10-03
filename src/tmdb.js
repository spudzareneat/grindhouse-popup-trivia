import { getJson } from './http.js';

const BASE = 'https://api.themoviedb.org/3';

// Optional source. TMDB v3 API key via TMDB_API_KEY; without one this is a no-op.
export function makeTmdb(apiKey, fetchImpl = fetch) {
    if (!apiKey) return { fetchExtras: async () => null };
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
    return { fetchExtras };
}
