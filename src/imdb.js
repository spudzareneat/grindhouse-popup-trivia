import { getJson } from './http.js';
import { titlesMatch } from './titles.js';

// IMDb's own website GraphQL endpoint: no key, accepts arbitrary queries over GET.
// Non-commercial use only (IMDb's disclaimer) -- fine for this personal project.
const GQL = 'https://caching.graphql.imdb.com/';
const IMDB_HEADERS = {
    'Accept': 'application/graphql+json, application/json',
    'Content-Type': 'application/json',
    'x-imdb-client-name': 'imdb-web-next-localized',
    'x-imdb-user-language': 'en-US',
    'x-imdb-user-country': 'US',
};

const SEARCH_Q = 'query MainSearch($term: String!) { mainSearch(first: 20, options: { searchTerm: $term, type: TITLE }) { edges { node { entity { ... on Title { id titleText { text } releaseYear { year } titleType { id isSeries isEpisode } ratingsSummary { voteCount } } } } } } }';

// Only the connection kinds that say how a film ties into other films --
// unfiltered, IMDb returns dozens of "Edited into"/"Featured in" clip-show rows first.
const CONNECTION_CATEGORIES = ['references', 'referenced_in', 'spoofs', 'spoofed_in', 'remake_of', 'remade_as', 'follows', 'followed_by', 'version_of', 'features'];

// Page sizes are generous on purpose: famous titles have hundreds of trivia/goof items and the
// model picks the best ones; an obscure title just returns what it has.
const BUNDLE_Q = 'query GHBundle($id: ID!){ title(id:$id){ id titleText{ text } releaseYear{ year } titleType{ id isSeries isEpisode } runtime{ seconds } plot{ plotText{ plainText } } '
    + 'trivia(first: 250){ edges{ node{ text{ plainText } } } } '
    + 'goofs(first: 150){ edges{ node{ text{ plainText } category{ text } } } } '
    + 'quotes(first: 40){ edges{ node{ lines{ characters{ character } text } } } } '
    + `connections(first: 60, filter: { categories: ${JSON.stringify(CONNECTION_CATEGORIES)} }){ edges{ node{ category{ text } associatedTitle{ id titleText{ text } releaseYear{ year } } } } } `
    + 'alternateVersions(first: 20){ edges{ node{ text{ plainText } } } } '
    + 'crazyCredits(first: 5){ edges{ node{ text{ plainText } } } } '
    + 'soundtrack(first: 30){ edges{ node{ text comments{ plainText } } } } '
    + 'filmingLocations(first: 25){ edges{ node{ text } } } '
    + 'cast: credits(first: 5, filter: { categories: ["cast"] }){ edges{ node{ name{ id nameText{ text } } ... on Cast { characters{ name } } } } } '
    + 'directors: credits(first: 2, filter: { categories: ["director"] }){ edges{ node{ name{ id nameText{ text } } } } } } }';

const PERSON_Q = 'query GHPerson($id: ID!){ name(id:$id){ primaryImage{ url } trivia(first: 8){ edges{ node{ text{ plainText } } } } knownFor(first: 6){ edges{ node{ title{ id titleText{ text } releaseYear{ year } } } } } } }';

// IMDb headshots live on Amazon's image CDN; the "._V1_..." suffix is a resize
// spec, so any primaryImage URL can be turned into a small square crop (~2 KB).
// Anything not on that CDN is rejected (null) -- the userscript only renders
// images from this host too.
const IMDB_IMAGE_PREFIX = 'https://m.media-amazon.com/images/';
export function headshotUrl(url) {
    if (typeof url !== 'string' || !url.startsWith(IMDB_IMAGE_PREFIX)) return null;
    const base = url.replace(/._V1_[^/]*.jpg$/, '').replace(/.jpg$/, '');
    return `${base}._V1_QL75_UX120_CR0,0,120,120_.jpg`;
}

const MOVIE_TYPES = ['movie', 'tvMovie', 'video'];
const byVotesDesc = (a, b) => (b.ratingsSummary?.voteCount ?? 0) - (a.ratingsSummary?.voteCount ?? 0);
const plainList = edges => (edges || []).map(e => e?.node?.text?.plainText).filter(Boolean);

export function makeImdb(fetchImpl = fetch) {
    async function query(op, q, variables) {
        const url = `${GQL}?operationName=${op}&query=${encodeURIComponent(q)}&variables=${encodeURIComponent(JSON.stringify(variables))}`;
        const j = await getJson(fetchImpl, url, IMDB_HEADERS);
        if (!j.data) throw new Error(`IMDb ${op}: ${j.errors?.[0]?.message || 'no data'}`);
        return j.data;
    }

    // Movie-ish titles first; series/episodes are never eligible (spec: skip TV).
    async function searchResults(term) {
        const data = await query('MainSearch', SEARCH_Q, { term });
        return (data.mainSearch?.edges || []).map(e => e?.node?.entity).filter(e => e && e.id);
    }
    const movieTypeOnly = results => results.filter(r => MOVIE_TYPES.includes(r.titleType?.id));

    async function searchAndMatch(term) {
        const results = await searchResults(term);
        const tiers = [
            movieTypeOnly(results),
            results.filter(r => !r.titleType?.isSeries && !r.titleType?.isEpisode && r.titleType?.id !== 'podcastEpisode'),
        ];
        for (const tier of tiers) {
            const m = tier.filter(r => titlesMatch(r.titleText?.text, term));
            if (m.length) return m;
        }
        return [];
    }

    // Stricter than the userscript: with a year, a title match whose year is more than
    // 1 off is treated as a different film (remake/original) -> null, never a guess.
    // (No bare-year recovery pass: schedule items always carry an explicit "(Year)", so a
    // title like "Class of 1984 (1982)" already parses with its trailing number intact.)
    async function searchTitle(title, year) {
        const matches = await searchAndMatch(title);
        if (!matches.length) return null;
        let pool = matches;
        if (year) {
            const exact = matches.filter(r => r.releaseYear?.year === year);
            const near = matches.filter(r => r.releaseYear?.year && Math.abs(r.releaseYear.year - year) <= 1);
            pool = exact.length ? exact : near;
        }
        if (!pool.length) return null;
        const best = pool.slice().sort(byVotesDesc)[0];
        return { tconst: best.id, title: best.titleText?.text ?? title, year: best.releaseYear?.year ?? year };
    }

    // Picker candidates: no title-similarity filter, the human chooses.
    async function searchCandidates(term) {
        return movieTypeOnly(await searchResults(term)).sort(byVotesDesc).slice(0, 10).map(r => ({
            tconst: r.id, title: r.titleText?.text ?? '', year: r.releaseYear?.year ?? null,
            votes: r.ratingsSummary?.voteCount ?? 0, source: 'imdb',
        }));
    }

    async function fetchPerson(p, excludeTconst) {
        try {
            const n = (await query('GHPerson', PERSON_Q, { id: p.nconst })).name;
            return {
                ...p,
                image: headshotUrl(n?.primaryImage?.url),
                trivia: plainList(n?.trivia?.edges),
                knownFor: (n?.knownFor?.edges || []).map(e => e?.node?.title)
                    .filter(t => t && t.id !== excludeTconst && t.titleText?.text)
                    .map(t => `${t.titleText.text} (${t.releaseYear?.year ?? '?'})`),
            };
        } catch {
            return { ...p, image: null, trivia: [], knownFor: [] };
        }
    }

    async function fetchBundle(tconst) {
        const t = (await query('GHBundle', BUNDLE_Q, { id: tconst })).title;
        if (!t) throw new Error(`IMDb: no title ${tconst}`);
        const people = [
            ...(t.cast?.edges || []).map(e => ({ nconst: e?.node?.name?.id, name: e?.node?.name?.nameText?.text, role: 'cast', character: e?.node?.characters?.[0]?.name ?? null })),
            ...(t.directors?.edges || []).map(e => ({ nconst: e?.node?.name?.id, name: e?.node?.name?.nameText?.text, role: 'director', character: null })),
        ].filter(p => p.nconst && p.name);
        const seen = new Set();
        const unique = people.filter(p => !seen.has(p.nconst) && seen.add(p.nconst));
        const enriched = [];
        for (const p of unique) enriched.push(await fetchPerson(p, tconst)); // sequential: be polite to IMDb
        return {
            tconst,
            title: t.titleText?.text ?? null,
            year: t.releaseYear?.year ?? null,
            isSeries: !!t.titleType?.isSeries,
            isEpisode: !!t.titleType?.isEpisode,
            runtimeSec: t.runtime?.seconds ?? null,
            plot: t.plot?.plotText?.plainText ?? null,
            trivia: plainList(t.trivia?.edges),
            goofs: (t.goofs?.edges || []).map(e => e?.node).filter(n => n?.text?.plainText)
                .map(n => `[${n.category?.text ?? 'Goof'}] ${n.text.plainText}`),
            quotes: (t.quotes?.edges || []).map(e => (e?.node?.lines || [])
                .map(l => `${l.characters?.[0]?.character ?? '?'}: ${l.text}`).join(' / ')).filter(Boolean),
            connections: (t.connections?.edges || []).map(e => e?.node).filter(n => n?.associatedTitle?.titleText?.text)
                .map(n => `${n.category?.text}: ${n.associatedTitle.titleText.text} (${n.associatedTitle.releaseYear?.year ?? '?'})`),
            alternateVersions: plainList(t.alternateVersions?.edges),
            crazyCredits: plainList(t.crazyCredits?.edges),
            soundtrack: (t.soundtrack?.edges || []).map(e => e?.node).filter(n => n?.text)
                .map(n => [n.text, ...(n.comments || []).map(c => c.plainText).filter(Boolean)].join(' — ')),
            filmingLocations: (t.filmingLocations?.edges || []).map(e => e?.node?.text).filter(Boolean),
            people: enriched,
        };
    }

    // IMDb's aggregate rating and vote count; null when the title has none (unreleased, too few votes) or is unknown.
    async function fetchRating(tconst) {
        const data = await query('GHRating', 'query GHRating($id: ID!){ title(id:$id){ ratingsSummary{ aggregateRating voteCount } } }', { id: tconst });
        const r = data.title?.ratingsSummary;
        if (r?.aggregateRating == null) return null;
        return { rating: r.aggregateRating, votes: r.voteCount ?? 0 };
    }

    // The IMDb half of the published lineup info (what Coming Attractions cards show). Field selections and result shapes are the
    // userscript's own (imdb-resolve.js fetchImdbTitleFields + movie-title-links fetchImdbTitleGuide) so a card looks the same
    // whether it comes from the published file or a local lookup. Null for an unknown title; rejects on a failed query.
    async function fetchLineupInfo(tconst) {
        const data = await query('GHLineup', LINEUP_Q, { id: tconst });
        const t = data.title;
        if (!t) return null;
        const guide = t.parentsGuide?.categories;
        const stars = (t.stars || []).flatMap(g => g?.credits || []);
        const credits = stars.length ? stars : (t.cast?.edges || []).map(e => e?.node);
        return {
            title: t.titleText?.text ?? null,
            year: t.releaseYear?.year ?? null,
            rating: t.ratingsSummary?.aggregateRating ?? null,
            runtime: t.runtime?.seconds != null ? Math.round(t.runtime.seconds / 60) : null,
            overview: t.plot?.plotText?.plainText ?? null,
            poster: t.primaryImage?.url ?? null,
            genres: (t.titleGenres?.genres || []).map(g => g.genre?.text).filter(Boolean),
            certificate: t.certificate?.rating ?? null,
            parentalGuide: guide ? guide.map(c => ({ category: c.category?.text, severity: c.severity?.text })).filter(c => c.category && c.severity) : null,
            cast: credits.map(c => ({
                name: c?.name?.nameText?.text ?? null,
                nconst: c?.name?.id ?? null,
                character: c?.characters?.[0]?.name ?? null,
                photo: castThumb(c?.name?.primaryImage?.url),
                knownFor: topKnownFor(c?.name?.knownFor, [tconst, t.series?.series?.id]),
            })).filter(c => c.name).slice(0, 3),
        };
    }

    return { query, searchTitle, searchCandidates, fetchBundle, fetchRating, fetchLineupInfo };
}

const CAST_PERSON = 'name{ id nameText{ text } primaryImage{ url } knownFor(first: 4){ edges{ node{ title{ id titleText{ text } releaseYear{ year } ratingsSummary{ voteCount } } } } } } ... on Cast { characters{ name } }';
const LINEUP_Q = 'query GHLineup($id: ID!){ title(id:$id){ id series{ series{ id } } titleText{ text } releaseYear{ year } ratingsSummary{ aggregateRating voteCount } '
    + 'runtime{ seconds } plot{ plotText{ plainText } } primaryImage{ url } titleGenres{ genres{ genre{ text } } } certificate{ rating } '
    + 'parentsGuide{ categories{ category{ text } severity{ text } } } '
    + 'stars: principalCredits(filter: { categories: ["cast"] }) { credits{ ' + CAST_PERSON + ' } } '
    + 'cast: credits(first: 3, filter: { categories: ["cast"] }) { edges{ node{ ' + CAST_PERSON + ' } } } } }';

// IMDb image URLs are full-size originals; the "._V1_..." suffix is a resize spec, so a small thumbnail is the same URL with
// a different suffix (the userscript's _imdbThumb does the same).
const castThumb = url => (url ? url.replace(/\._V1_[^/]*\.jpg$/, '._V1_UX120_.jpg') : null);

// A cast member's single most-voted known-for title, excluding this film (and its series, for episodes).
function topKnownFor(knownFor, excludeIds) {
    const titles = (knownFor?.edges || []).map(e => e?.node?.title)
        .filter(t => t && t.id && !excludeIds.includes(t.id) && t.titleText?.text);
    if (!titles.length) return null;
    titles.sort((a, b) => (b.ratingsSummary?.voteCount ?? 0) - (a.ratingsSummary?.voteCount ?? 0));
    return { title: titles[0].titleText.text, year: titles[0].releaseYear?.year ?? null, tconst: titles[0].id };
}
