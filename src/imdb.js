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

const BUNDLE_Q = 'query GHBundle($id: ID!){ title(id:$id){ id titleText{ text } releaseYear{ year } titleType{ id isSeries isEpisode } runtime{ seconds } plot{ plotText{ plainText } } '
    + 'trivia(first: 50){ edges{ node{ text{ plainText } } } } '
    + 'goofs(first: 20){ edges{ node{ text{ plainText } category{ text } } } } '
    + 'quotes(first: 10){ edges{ node{ lines{ characters{ character } text } } } } '
    + `connections(first: 40, filter: { categories: ${JSON.stringify(CONNECTION_CATEGORIES)} }){ edges{ node{ category{ text } associatedTitle{ id titleText{ text } releaseYear{ year } } } } } `
    + 'alternateVersions(first: 10){ edges{ node{ text{ plainText } } } } '
    + 'crazyCredits(first: 5){ edges{ node{ text{ plainText } } } } '
    + 'soundtrack(first: 10){ edges{ node{ text comments{ plainText } } } } '
    + 'filmingLocations(first: 10){ edges{ node{ text } } } '
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
    async function searchAndMatch(term) {
        const data = await query('MainSearch', SEARCH_Q, { term });
        const results = (data.mainSearch?.edges || []).map(e => e?.node?.entity).filter(e => e && e.id);
        const tiers = [
            results.filter(r => MOVIE_TYPES.includes(r.titleType?.id)),
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

    return { query, searchTitle, fetchBundle };
}
