// The per-film `info` object published inside schedule/current.json: everything Coming Attractions shows, merged once
// here instead of in every viewer's browser. Shape and priority mirror the userscript's lookupMovie result: TMDB first,
// IMDb as the fallback for the shared fields; certificate, parental guide and cast are IMDb's; kill count is keyed by TMDB id.
// See docs/superpowers/specs/2026-11-21-published-lineup-info-design.md.

const KILLCOUNTS_OK_TTL_MS = 10 * 60 * 1000;   // a good download is reused for ten minutes (a long-lived bot must not serve it forever)
const KILLCOUNTS_FAIL_RETRY_MS = 60 * 1000;    // an empty/failed one is retried after a minute, but not once per film within a publish

// killCounts: () => Promise<Map<string, number>>, called lazily (only once a film has a TMDB id). An empty map means the
// download failed (the real database has thousands of entries).
// Returns (tconst) => Promise<Info | null>. Never throws: a failing source nulls only its own fields and flags the result
// `partial: true` (a source that simply has nothing for the film, such as no TMDB key or no Wikipedia hit, is NOT a failure),
// so callers can retry it. The result is null only when neither IMDb nor TMDB yields a title.
export function makeFetchInfo({ imdb, tmdb, wiki, killCounts, now = Date.now }) {
    let cached = null;    // { at, ok, map }
    let inflight = null;
    async function loadKillCounts() {
        if (cached && now() - cached.at < (cached.ok ? KILLCOUNTS_OK_TTL_MS : KILLCOUNTS_FAIL_RETRY_MS)) return cached;
        inflight ??= (async () => {
            let map = null;
            try { map = await killCounts(); } catch { map = null; }
            const ok = map instanceof Map && map.size > 0;
            cached = { at: now(), ok, map: ok ? map : new Map() };
            return cached;
        })().finally(() => { inflight = null; });
        return inflight;
    }

    return async function fetchInfo(tconst) {
        let failed = false;
        const guarded = async fn => { try { return (await fn()) ?? null; } catch { failed = true; return null; } };

        const [i, t] = await Promise.all([guarded(() => imdb.fetchLineupInfo(tconst)), guarded(() => tmdb.fetchLineup(tconst))]);
        const cleanTitle = t?.title ?? i?.title ?? null;
        if (!cleanTitle) return null;
        const cleanYear = t?.year ?? i?.year ?? null;
        const [wikiUrl, kc] = await Promise.all([
            guarded(() => wiki.fetchWikipediaUrl(cleanTitle, cleanYear)),
            t?.tmdbId != null ? loadKillCounts() : Promise.resolve(null),
        ]);
        if (kc && !kc.ok) failed = true;
        return {
            imdbId: tconst,
            cleanTitle,
            cleanYear,
            rating: t?.rating ?? i?.rating ?? null,
            runtime: t?.runtime ?? i?.runtime ?? null,
            genres: t?.genres?.length ? t.genres : (i?.genres ?? []),
            poster: t?.poster ?? i?.poster ?? null,
            // IMDb has no wide backdrop, so its poster stands in (the card crops it), as in the userscript.
            backdrop: t?.backdrop ?? i?.poster ?? null,
            overview: t?.overview ?? i?.overview ?? null,
            certificate: i?.certificate ?? null,
            parentalGuide: i?.parentalGuide ?? null,
            cast: i?.cast ?? null,
            killCount: kc?.map.get(String(t.tmdbId)) ?? null,
            links: {
                imdb: `https://www.imdb.com/title/${tconst}/`,
                letterboxd: `https://letterboxd.com/imdb/${tconst}`,
                wiki: wikiUrl,
            },
            ...(failed ? { partial: true } : {}),
        };
    };
}
