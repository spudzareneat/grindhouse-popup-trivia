// The per-film `info` object published inside schedule/current.json: everything Coming Attractions shows, merged once
// here instead of in every viewer's browser. Shape and priority mirror the userscript's lookupMovie result: TMDB first,
// IMDb as the fallback for the shared fields; certificate, parental guide and cast are IMDb's; kill count is keyed by TMDB id.
// See docs/superpowers/specs/2026-11-21-published-lineup-info-design.md.

const attempt = async fn => { try { return (await fn()) ?? null; } catch { return null; } };

// killCounts: () => Promise<Map<string, number>>, called lazily (only once a film has a TMDB id) and at most once.
// Returns (tconst) => Promise<Info | null>. Never throws: a failing source nulls only its own fields, and the result is null
// only when neither IMDb nor TMDB yields a title.
export function makeFetchInfo({ imdb, tmdb, wiki, killCounts }) {
    let killCountsPromise = null;
    const loadKillCounts = () => (killCountsPromise ??= Promise.resolve().then(() => killCounts()).catch(() => new Map()));

    return async function fetchInfo(tconst) {
        const [i, t] = await Promise.all([attempt(() => imdb.fetchLineupInfo(tconst)), attempt(() => tmdb.fetchLineup(tconst))]);
        const cleanTitle = t?.title ?? i?.title ?? null;
        if (!cleanTitle) return null;
        const cleanYear = t?.year ?? i?.year ?? null;
        const [wikiUrl, counts] = await Promise.all([
            attempt(() => wiki.fetchWikipediaUrl(cleanTitle, cleanYear)),
            t?.tmdbId != null ? attempt(loadKillCounts) : Promise.resolve(null),
        ]);
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
            killCount: counts?.get(String(t.tmdbId)) ?? null,
            links: {
                imdb: `https://www.imdb.com/title/${tconst}/`,
                letterboxd: `https://letterboxd.com/imdb/${tconst}`,
                wiki: wikiUrl,
            },
        };
    };
}
