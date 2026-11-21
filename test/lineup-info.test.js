import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFetchInfo } from '../src/lineup-info.js';

const IMDB = {
    title: 'Zeiram (IMDb)', year: 1990, rating: 6.1, runtime: 86, overview: 'imdb plot', poster: 'https://imdb/poster.jpg',
    genres: ['Action'], certificate: 'Not Rated', parentalGuide: [{ category: 'Violence & Gore', severity: 'Moderate' }],
    cast: [{ name: 'Star', nconst: 'nm1', character: 'Iria', photo: 'https://imdb/photo.jpg', knownFor: null }],
};
const TMDB = {
    tmdbId: 603, title: 'Zeiram', year: 1991, rating: 6.4, runtime: 85, genres: ['Action', 'Sci-Fi'],
    poster: 'https://tmdb/p.jpg', backdrop: 'https://tmdb/b.jpg', overview: 'tmdb plot',
};
const make = (over = {}) => makeFetchInfo({
    imdb: { fetchLineupInfo: async () => IMDB },
    tmdb: { fetchLineup: async () => TMDB },
    wiki: { fetchWikipediaUrl: async () => 'https://en.wikipedia.org/wiki/Zeiram' },
    killCounts: async () => new Map([['603', 12]]),
    ...over,
});

test('TMDB values win and IMDb fills certificate, parental guide and cast', async () => {
    const info = await make()('tt0103327');
    assert.deepEqual(info, {
        imdbId: 'tt0103327', cleanTitle: 'Zeiram', cleanYear: 1991, rating: 6.4, runtime: 85, genres: ['Action', 'Sci-Fi'],
        poster: 'https://tmdb/p.jpg', backdrop: 'https://tmdb/b.jpg', overview: 'tmdb plot',
        certificate: 'Not Rated', parentalGuide: IMDB.parentalGuide, cast: IMDB.cast, killCount: 12,
        links: { imdb: 'https://www.imdb.com/title/tt0103327/', letterboxd: 'https://letterboxd.com/imdb/tt0103327', wiki: 'https://en.wikipedia.org/wiki/Zeiram' },
    });
});
test('without a TMDB result every merged field comes from IMDb, backdrop falls back to the IMDb poster, killCount is null', async () => {
    const info = await make({ tmdb: { fetchLineup: async () => null } })('tt1');
    assert.deepEqual([info.cleanTitle, info.cleanYear, info.rating, info.runtime, info.genres, info.poster, info.backdrop, info.overview, info.killCount],
        ['Zeiram (IMDb)', 1990, 6.1, 86, ['Action'], 'https://imdb/poster.jpg', 'https://imdb/poster.jpg', 'imdb plot', null]);
});
test('kill count is looked up by the TMDB id and is null when the film is not in the database', async () => {
    assert.equal((await make({ killCounts: async () => new Map([['999', 3]]) })('tt1')).killCount, null);
});
test('each source failing nulls only its own fields', async () => {
    const boom = async () => { throw new Error('down'); };
    const noImdb = await make({ imdb: { fetchLineupInfo: boom } })('tt1');
    assert.deepEqual([noImdb.cleanTitle, noImdb.certificate, noImdb.parentalGuide, noImdb.cast], ['Zeiram', null, null, null]);
    const noTmdb = await make({ tmdb: { fetchLineup: boom } })('tt1');
    assert.deepEqual([noTmdb.cleanTitle, noTmdb.poster, noTmdb.killCount, noTmdb.certificate], ['Zeiram (IMDb)', 'https://imdb/poster.jpg', null, 'Not Rated']);
    const noWiki = await make({ wiki: { fetchWikipediaUrl: boom } })('tt1');
    assert.deepEqual([noWiki.links.wiki, noWiki.links.imdb === 'https://www.imdb.com/title/tt1/', noWiki.cleanTitle], [null, true, 'Zeiram']);
    const noKill = await make({ killCounts: boom })('tt1');
    assert.deepEqual([noKill.killCount, noKill.cleanTitle], [null, 'Zeiram']);
});
test('returns null when neither IMDb nor TMDB yields a title', async () => {
    assert.equal(await make({ imdb: { fetchLineupInfo: async () => null }, tmdb: { fetchLineup: async () => null } })('tt1'), null);
    const boom = async () => { throw new Error('down'); };
    assert.equal(await make({ imdb: { fetchLineupInfo: boom }, tmdb: { fetchLineup: boom } })('tt1'), null);
});
test('the kill-count loader runs once across several films, and not at all when no film has a TMDB id', async () => {
    let loads = 0;
    const fetchInfo = make({ killCounts: async () => { loads++; return new Map([['603', 1]]); } });
    await fetchInfo('tt1'); await fetchInfo('tt2'); await fetchInfo('tt3');
    assert.equal(loads, 1);
    let loads2 = 0;
    await make({ tmdb: { fetchLineup: async () => null }, killCounts: async () => { loads2++; return new Map(); } })('tt1');
    assert.equal(loads2, 0);
});

// --- Final-review fixes ---
test('info is flagged partial when a source FAILED, and not when a source simply has nothing', async () => {
    const boom = async () => { throw new Error('down'); };
    assert.ok(!('partial' in await make()('tt1')));
    assert.ok(!('partial' in await make({ tmdb: { fetchLineup: async () => null } })('tt1')), 'no TMDB key / no TMDB match is normal');
    assert.ok(!('partial' in await make({ wiki: { fetchWikipediaUrl: async () => null } })('tt1')), 'no Wikipedia hit is normal');
    assert.ok(!('partial' in await make({ killCounts: async () => new Map([['999', 3]]) })('tt1')), 'film not in the kill-count db is normal');
    for (const over of [{ imdb: { fetchLineupInfo: boom } }, { tmdb: { fetchLineup: boom } }, { wiki: { fetchWikipediaUrl: boom } }, { killCounts: boom }, { killCounts: async () => new Map() }]) {
        assert.equal((await make(over)('tt1')).partial, true);
    }
});
test('the kill-count database is cached for a while, but an empty or failed download is retried after a minute', async () => {
    let t = 0, loads = 0, mode = 'empty';
    const fetchInfo = make({ now: () => t, killCounts: async () => { loads++; return mode === 'ok' ? new Map([['603', 1]]) : new Map(); } });
    await fetchInfo('a'); await fetchInfo('b');
    assert.equal(loads, 1, 'a failure is not re-downloaded for every film');
    t = 61000; mode = 'ok';
    assert.equal((await fetchInfo('c')).killCount, 1);
    assert.equal(loads, 2);
    t = 61000 + 9 * 60000; await fetchInfo('d');
    assert.equal(loads, 2, 'a good download is reused');
    t = 61000 + 11 * 60000; await fetchInfo('e');
    assert.equal(loads, 3, 'and refreshed after ten minutes (a long-lived bot must not serve it forever)');
});
