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

// Wikipedia pages for the film's people (via their IMDb nm ids) and for what frames the film:
// its series, production company, and source work. Feeds the "famous for…" and studio-history
// bubbles without spending Claude's research turns on looking them up.
const RELATED_PROPS = [['P179', 'series'], ['P272', 'production company'], ['P144', 'based on']];
function relatedSparql(qid, nconsts) {
    const enwiki = '?article schema:about ?x ; schema:isPartOf <https://en.wikipedia.org/> .';
    const people = nconsts.length
        ? `{ VALUES ?key { ${nconsts.map(n => `"${n}"`).join(' ')} } ?x wdt:P345 ?key . ${enwiki} BIND("person" AS ?kind) }`
        : '';
    const related = qid
        ? `{ VALUES (?prop ?kind) { ${RELATED_PROPS.map(([p, k]) => `(wdt:${p} "${k}")`).join(' ')} } wd:${qid} ?prop ?x . ${enwiki} BIND("" AS ?key) }`
        : '';
    return `SELECT ?kind ?key ?article WHERE { ${[people, related].filter(Boolean).join(' UNION ')} }`;
}
const articleTitle = url => decodeURIComponent(url.split('/wiki/')[1]).replace(/_/g, ' ');

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

    // Lead sections only (the "best known for" part), up to 20 titles per API call.
    async function fetchWikipediaIntros(titles, maxChars = 1500) {
        const out = {};
        for (let i = 0; i < titles.length; i += 20) {
            const batch = titles.slice(i, i + 20);
            const url = `${WP_API}?action=query&prop=extracts&exintro=1&explaintext=1&exlimit=20&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(batch.join('|'))}`;
            const j = await getJson(fetchImpl, url);
            const back = {};   // follow normalization/redirects back to the title we asked for
            for (const m of [...(j.query?.normalized || []), ...(j.query?.redirects || [])]) back[m.to] = back[m.from] ?? m.from;
            for (const p of j.query?.pages || []) {
                if (!p.extract) continue;
                out[back[p.title] ?? p.title] = p.extract.trim().slice(0, maxChars);
            }
        }
        return out;
    }

    // -> [{ kind: 'person'|'series'|'production company'|'based on', key: nconst|'', title, intro }]
    async function fetchRelatedArticles(qid, nconsts = []) {
        const ids = nconsts.filter(n => /^nm\d+$/.test(n));
        const q = /^Q\d+$/.test(qid || '') ? qid : null;
        if (!q && !ids.length) return [];
        const url = `${SPARQL}?format=json&query=${encodeURIComponent(relatedSparql(q, ids))}`;
        const j = await getJson(fetchImpl, url, { Accept: 'application/sparql-results+json' }, 30000);
        const seen = new Set();
        const rows = (j.results?.bindings || []).map(b => ({ kind: b.kind.value, key: b.key?.value || '', title: articleTitle(b.article.value) }))
            .filter(r => !seen.has(r.title) && seen.add(r.title));
        const intros = rows.length ? await fetchWikipediaIntros(rows.map(r => r.title)) : {};
        return rows.filter(r => intros[r.title]).map(r => ({ ...r, intro: intros[r.title] }));
    }

    return { fetchWikidata, fetchWikipediaExtract, fetchWikipediaIntros, fetchRelatedArticles };
}
