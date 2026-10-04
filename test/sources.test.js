import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWiki } from '../src/wiki.js';
import { parseCsv, parseTotals, findTotals, fetchTotals, TOTALS_CSV_URL } from '../src/driveintotals.js';
import { makeTmdb } from '../src/tmdb.js';
import { jsonResponse, textResponse } from './helpers.js';

test('fetchWikidata parses grouped SPARQL bindings', async () => {
    let seen;
    const fetchImpl = async (url, opts) => { seen = { url, opts }; return jsonResponse({ results: { bindings: [{
        item: { value: 'http://www.wikidata.org/entity/Q1852671' },
        article: { value: 'https://en.wikipedia.org/wiki/Carnival_of_Souls' },
        budgets: { value: '33000' }, boxoffice: { value: '' }, basedOn: { value: '' }, follows: { value: '' },
        followedBy: { value: '' }, locations: { value: 'Salt Lake City|Kansas' }, awards: { value: '' }, nominations: { value: '' },
    }] } }); };
    const w = await makeWiki(fetchImpl).fetchWikidata('tt0055830');
    assert.match(decodeURIComponent(seen.url), /wdt:P345 "tt0055830"/);
    assert.equal(seen.opts.headers.Accept, 'application/sparql-results+json');
    assert.deepEqual(w, { qid: 'Q1852671', wikipediaTitle: 'Carnival of Souls', budget: ['33000'], boxOffice: [], basedOn: [], follows: [], followedBy: [], locations: ['Salt Lake City', 'Kansas'], awards: [], nominations: [] });
});
test('fetchWikidata: no match -> null; bad id -> throws', async () => {
    assert.equal(await makeWiki(async () => jsonResponse({ results: { bindings: [] } })).fetchWikidata('tt1'), null);
    await assert.rejects(makeWiki(async () => jsonResponse({})).fetchWikidata('nope"}'), /bad imdb id/);
});
test('fetchWikipediaExtract returns truncated plaintext, null when missing', async () => {
    const wiki = makeWiki(async (url) => jsonResponse(url.includes('Missing')
        ? { query: { pages: [{ missing: true }] } }
        : { query: { pages: [{ extract: 'x'.repeat(50) }] } }));
    assert.equal(await wiki.fetchWikipediaExtract('Carnival of Souls', 10), 'x'.repeat(10));
    assert.equal(await wiki.fetchWikipediaExtract('Missing'), null);
});

const CSV = 'title,year,description,transcribed,llm_model\n'
    + 'Carnival of Souls,1962,"Nineteen dead bodies. Church organ Fu. ""Quoted"" bit, with comma.",,\n'
    + 'The Fly,1958,Old fly totals.,,\n'
    + 'The Fly,1986,New fly totals.,,\n'
    + 'Empty Row,1970,,,\n';

test('parseCsv handles quotes, escaped quotes, commas, CRLF', () => {
    assert.deepEqual(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\r\n'), [['a', 'b,c', 'd "e"'], ['1', '2', '3']]);
});
test('parseTotals drops rows without description', () => {
    const rows = parseTotals(CSV);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].description, 'Nineteen dead bodies. Church organ Fu. "Quoted" bit, with comma.');
});
test('findTotals matches title+year, +-1 year, and refuses ambiguous yearless', () => {
    const rows = parseTotals(CSV);
    assert.match(findTotals(rows, 'Carnival of Souls', 1962), /Nineteen/);
    assert.match(findTotals(rows, 'carnival of souls', 1963), /Nineteen/);
    assert.equal(findTotals(rows, 'The Fly', 1986), 'New fly totals.');
    assert.equal(findTotals(rows, 'The Fly', null), null);
    assert.match(findTotals(rows, 'Carnival of Souls', null), /Nineteen/);
    assert.equal(findTotals(rows, 'Carnival of Souls', 1990), null);
});
test('fetchTotals pulls the raw CSV', async () => {
    let seenUrl;
    const rows = await fetchTotals(async (url) => { seenUrl = url; return textResponse(CSV); });
    assert.equal(seenUrl, TOTALS_CSV_URL);
    assert.equal(rows.length, 3);
});

test('tmdb without key -> null, no requests', async () => {
    let called = false;
    assert.equal(await makeTmdb('', async () => { called = true; }).fetchExtras('tt1'), null);
    assert.equal(called, false);
});
test('tmdb with key -> keywords, collection, tagline, money', async () => {
    const fetchImpl = async (url) => {
        if (url.includes('/find/')) return jsonResponse({ movie_results: [{ id: 42 }] });
        if (url.includes('/keywords')) return jsonResponse({ keywords: [{ name: 'zombie' }, { name: 'organ' }] });
        return jsonResponse({ belongs_to_collection: { name: 'Souls Collection' }, tagline: 'Tag', budget: 33000, revenue: 0 });
    };
    assert.deepEqual(await makeTmdb('k', fetchImpl).fetchExtras('tt0055830'),
        { keywords: ['zombie', 'organ'], collection: 'Souls Collection', tagline: 'Tag', budget: 33000, revenue: null });
});

test('fetchRelatedArticles: people by nm id + studio, with lead-section intros (redirects mapped back)', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
        urls.push(decodeURIComponent(url));
        if (url.includes('sparql')) return jsonResponse({ results: { bindings: [
            { kind: { value: 'person' }, key: { value: 'nm0514904' }, article: { value: 'https://en.wikipedia.org/wiki/Gordon_Liu' } },
            { kind: { value: 'production company' }, key: { value: '' }, article: { value: 'https://en.wikipedia.org/wiki/Shaw_Brothers_Studio' } },
            { kind: { value: 'person' }, key: { value: 'nm1' }, article: { value: 'https://en.wikipedia.org/wiki/No_Intro' } },
        ] } });
        return jsonResponse({ query: { redirects: [{ from: 'Shaw Brothers Studio', to: 'Shaw Brothers' }], pages: [
            { title: 'Gordon Liu', extract: 'Gordon Liu is an actor.' }, { title: 'Shaw Brothers', extract: 'x'.repeat(2000) }, { title: 'No Intro', missing: true },
        ] } });
    };
    const r = await makeWiki(fetchImpl).fetchRelatedArticles('Q123', ['nm0514904', 'nm1', 'bad"id']);
    assert.match(urls[0], /VALUES \?key \{ "nm0514904" "nm1" \}/);
    assert.match(urls[0], /wd:Q123 \?prop/);
    assert.ok(!urls[0].includes('bad"id'));
    assert.match(urls[1], /exintro=1/);
    assert.deepEqual(r.map(x => [x.kind, x.key, x.title, x.intro.length]), [
        ['person', 'nm0514904', 'Gordon Liu', 23],
        ['production company', '', 'Shaw Brothers Studio', 1500],
    ]);
});
test('fetchRelatedArticles: nothing to look up -> [] without a request; bad qid ignored', async () => {
    let calls = 0;
    const wiki = makeWiki(async () => { calls++; return jsonResponse({ results: { bindings: [] } }); });
    assert.deepEqual(await wiki.fetchRelatedArticles(null, []), []);
    assert.deepEqual(await wiki.fetchRelatedArticles('Q1} DROP', []), []);
    assert.equal(calls, 0);
});
