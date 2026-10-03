import { getJson } from './http.js';

const SPARQL = 'https://query.wikidata.org/sparql';
const WP_API = 'https://en.wikipedia.org/w/api.php';
const LISTS = { budgets: 'budget', boxoffice: 'boxOffice', basedOn: 'basedOn', follows: 'follows', followedBy: 'followedBy', locations: 'locations', awards: 'awards', nominations: 'nominations' };

function sparqlFor(tconst) {
    const label = (v, prop, out) => `OPTIONAL { ?item wdt:${prop} ?${v} . ?${v} rdfs:label ?${out} . FILTER(LANG(?${out})="en") }`;
    const cat = (v, out) => `(GROUP_CONCAT(DISTINCT ?${v};separator="|") AS ?${out})`;
    return `SELECT ?item ?article ${cat('budget', 'budgets')} ${cat('box', 'boxoffice')} ${cat('basedOnL', 'basedOn')} ${cat('followsL', 'follows')} ${cat('followedByL', 'followedBy')} ${cat('locL', 'locations')} ${cat('awardL', 'awards')} ${cat('nomL', 'nominations')}
WHERE {
 ?item wdt:P345 "${tconst}" .
 OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
 OPTIONAL { ?item wdt:P2130 ?budget . }
 OPTIONAL { ?item wdt:P2142 ?box . }
 ${label('b', 'P144', 'basedOnL')}
 ${label('f', 'P155', 'followsL')}
 ${label('fb', 'P156', 'followedByL')}
 ${label('l', 'P915', 'locL')}
 ${label('a', 'P166', 'awardL')}
 ${label('n', 'P1411', 'nomL')}
} GROUP BY ?item ?article`;
}

export function makeWiki(fetchImpl = fetch) {
    async function fetchWikidata(tconst) {
        if (!/^tt\d+$/.test(tconst)) throw new Error(`bad imdb id: ${tconst}`);
        const url = `${SPARQL}?format=json&query=${encodeURIComponent(sparqlFor(tconst))}`;
        const j = await getJson(fetchImpl, url, { Accept: 'application/sparql-results+json' }, 30000);
        const b = j.results?.bindings?.[0];
        if (!b) return null;
        const out = {
            qid: b.item.value.split('/').pop(),
            wikipediaTitle: b.article ? decodeURIComponent(b.article.value.split('/wiki/')[1]).replace(/_/g, ' ') : null,
        };
        for (const [k, name] of Object.entries(LISTS)) out[name] = (b[k]?.value || '').split('|').map(s => s.trim()).filter(Boolean);
        return out;
    }

    async function fetchWikipediaExtract(title, maxChars = 40000) {
        const url = `${WP_API}?action=query&prop=extracts&explaintext=1&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(title)}`;
        const j = await getJson(fetchImpl, url);
        const ex = j.query?.pages?.[0]?.extract;
        return ex ? ex.slice(0, maxChars) : null;
    }

    return { fetchWikidata, fetchWikipediaExtract };
}
