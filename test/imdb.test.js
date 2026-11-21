import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeImdb } from '../src/imdb.js';
import { imdbStub } from './helpers.js';

const ent = (id, text, year, type = 'movie', votes = 100, extra = {}) =>
    ({ node: { entity: { id, titleText: { text }, releaseYear: { year }, titleType: { id: type, isSeries: type === 'tvSeries', isEpisode: type === 'tvEpisode' }, ratingsSummary: { voteCount: votes }, ...extra } } });
const search = (edges) => ({ mainSearch: { edges } });

test('searchTitle picks exact-year title match, most votes', async () => {
    const imdb = makeImdb(imdbStub(() => search([
        ent('tt1', 'Alligator', 1980, 'movie', 9000), ent('tt2', 'The Alligator People', 1959), ent('tt3', 'Alligator', 1980, 'video', 5),
    ])));
    assert.deepEqual(await imdb.searchTitle('Alligator', 1980), { tconst: 'tt1', title: 'Alligator', year: 1980 });
});
test('searchTitle accepts +-1 year when no exact', async () => {
    const imdb = makeImdb(imdbStub(() => search([ent('tt9', 'Decampitated', 1999)])));
    assert.equal((await imdb.searchTitle('Decampitated', 1998)).tconst, 'tt9');
});
test('searchTitle: title matches but years off -> null (do not research the wrong film)', async () => {
    const imdb = makeImdb(imdbStub(() => search([ent('tt5', 'The Fly', 1986)])));
    assert.equal(await imdb.searchTitle('The Fly', 1958), null);
});
test('searchTitle excludes TV episodes and series', async () => {
    const imdb = makeImdb(imdbStub(() => search([ent('tt7', 'Alligator', 1980, 'tvEpisode', 99999), ent('tt8', 'Alligator', 1980, 'tvSeries', 99999)])));
    assert.equal(await imdb.searchTitle('Alligator', 1980), null);
});
test('searchTitle: no title match -> null after exactly one search', async () => {
    const calls = [];
    const imdb = makeImdb(imdbStub(() => search([ent('tt0', 'Class Action', 1991)]), calls));
    assert.equal(await imdb.searchTitle('Class of 1984', 1982), null);
    assert.equal(calls.length, 1);
});
test('searchTitle yearless -> most-voted title match', async () => {
    const imdb = makeImdb(imdbStub(() => search([ent('tt1', 'Mystery Film', 1970, 'movie', 5), ent('tt2', 'Mystery Film', 2001, 'movie', 50)])));
    assert.equal((await imdb.searchTitle('Mystery Film', null)).tconst, 'tt2');
});

const TITLE = {
    title: {
        id: 'tt0055830', titleText: { text: 'Carnival of Souls' }, releaseYear: { year: 1962 },
        titleType: { id: 'movie', isSeries: false, isEpisode: false }, runtime: { seconds: 4680 }, plot: { plotText: { plainText: 'Plot.' } },
        trivia: { edges: [{ node: { text: { plainText: 'Trivia 1' } } }] },
        goofs: { edges: [{ node: { text: { plainText: 'Head turns.' }, category: { text: 'Continuity' } } }] },
        quotes: { edges: [{ node: { lines: [{ characters: [{ character: 'Mary Henry' }], text: 'In the dark...' }] } }] },
        connections: { edges: [{ node: { category: { text: 'Referenced in' }, associatedTitle: { id: 'tt1', titleText: { text: 'Night of the Living Dead' }, releaseYear: { year: 1968 } } } }] },
        alternateVersions: { edges: [{ node: { text: { plainText: 'Cut by 4 minutes.' } } }] },
        crazyCredits: { edges: [] },
        soundtrack: { edges: [{ node: { text: 'Organ Theme', comments: [{ plainText: 'Played by Gene Moore' }] } }] },
        filmingLocations: { edges: [{ node: { text: 'Saltair Pavilion, Utah' } }] },
        cast: { edges: [{ node: { name: { id: 'nm1', nameText: { text: 'Candace Hilligoss' } }, characters: [{ name: 'Mary Henry' }] } }] },
        directors: { edges: [{ node: { name: { id: 'nm2', nameText: { text: 'Herk Harvey' } } } }, { node: { name: { id: 'nm1', nameText: { text: 'Candace Hilligoss' } } } }] },
    },
};

test('fetchBundle maps every section to strings and enriches people', async () => {
    const imdb = makeImdb(imdbStub((op, v) => op === 'GHBundle' ? TITLE :
        v.id === 'nm2' ? new Error('boom') :
        { name: { trivia: { edges: [{ node: { text: { plainText: 'P trivia' } } }] }, knownFor: { edges: [{ node: { title: { id: 'tt0055830', titleText: { text: 'Carnival of Souls' }, releaseYear: { year: 1962 } } } }, { node: { title: { id: 'tt9', titleText: { text: 'Other' }, releaseYear: { year: 1970 } } } }] } } }));
    const b = await imdb.fetchBundle('tt0055830');
    assert.equal(b.runtimeSec, 4680);
    assert.equal(b.isEpisode, false);
    assert.deepEqual(b.goofs, ['[Continuity] Head turns.']);
    assert.deepEqual(b.quotes, ['Mary Henry: In the dark...']);
    assert.deepEqual(b.connections, ['Referenced in: Night of the Living Dead (1968)']);
    assert.deepEqual(b.soundtrack, ['Organ Theme — Played by Gene Moore']);
    assert.deepEqual(b.people.map(p => [p.name, p.role, p.character]), [['Candace Hilligoss', 'cast', 'Mary Henry'], ['Herk Harvey', 'director', null]]);
    assert.deepEqual(b.people[0].knownFor, ['Other (1970)']);   // current title excluded
    assert.deepEqual(b.people[1].trivia, []);                    // per-person failure tolerated
});
test('fetchBundle: null runtime stays null; GraphQL error with no data throws', async () => {
    const t = structuredClone(TITLE); t.title.runtime = null;
    const imdb = makeImdb(imdbStub((op) => op === 'GHBundle' ? t : { name: null }));
    assert.equal((await imdb.fetchBundle('tt0055830')).runtimeSec, null);
    await assert.rejects(makeImdb(imdbStub(() => new Error('bad query'))).fetchBundle('tt1'), /bad query/);
});

import { headshotUrl } from '../src/imdb.js';

test('headshotUrl turns an IMDb image into a 120px square crop; rejects other hosts', () => {
    assert.equal(headshotUrl('https://m.media-amazon.com/images/M/MV5BOGRm@._V1_.jpg'),
        'https://m.media-amazon.com/images/M/MV5BOGRm@._V1_QL75_UX120_CR0,0,120,120_.jpg');
    assert.equal(headshotUrl('https://m.media-amazon.com/images/M/MV5Bxyz@@.jpg'),
        'https://m.media-amazon.com/images/M/MV5Bxyz@@._V1_QL75_UX120_CR0,0,120,120_.jpg');
    assert.equal(headshotUrl('https://evil.example/images/a.jpg'), null);
    assert.equal(headshotUrl(null), null);
});
test('fetchBundle people carry a headshot (or null when IMDb has none / lookup fails)', async () => {
    const imdb = makeImdb(imdbStub((op, v) => op === 'GHBundle' ? TITLE :
        v.id === 'nm2' ? new Error('boom') :
        { name: { primaryImage: { url: 'https://m.media-amazon.com/images/M/abc@._V1_.jpg' }, trivia: { edges: [] }, knownFor: { edges: [] } } }));
    const b = await imdb.fetchBundle('tt0055830');
    assert.equal(b.people[0].image, 'https://m.media-amazon.com/images/M/abc@._V1_QL75_UX120_CR0,0,120,120_.jpg');
    assert.equal(b.people[1].image, null);
});

test('searchCandidates: movies and videos only, most votes first, no similarity filter', async () => {
    const imdb = makeImdb(imdbStub(() => search([
        ent('tt1', 'Totally Different', 1980, 'movie', 10),
        ent('tt2', 'Some Series', 1990, 'tvSeries', 9999),
        ent('tt3', 'Straight To Tape', 1995, 'video', 500),
    ])));
    const c = await imdb.searchCandidates('whatever');
    assert.deepEqual(c, [
        { tconst: 'tt3', title: 'Straight To Tape', year: 1995, votes: 500, source: 'imdb' },
        { tconst: 'tt1', title: 'Totally Different', year: 1980, votes: 10, source: 'imdb' },
    ]);
});

test('fetchRating returns rating and votes', async () => {
    const calls = [];
    const imdb = makeImdb(imdbStub(() => ({ title: { ratingsSummary: { aggregateRating: 6.4, voteCount: 3100 } } }), calls));
    assert.deepEqual(await imdb.fetchRating('tt0103327'), { rating: 6.4, votes: 3100 });
    assert.deepEqual(calls, [{ op: 'GHRating', vars: { id: 'tt0103327' } }]);
});
test('fetchRating returns null when there is no rating', async () => {
    assert.equal(await makeImdb(imdbStub(() => ({ title: { ratingsSummary: null } }))).fetchRating('tt1'), null);
    assert.equal(await makeImdb(imdbStub(() => ({ title: { ratingsSummary: { aggregateRating: null, voteCount: 0 } } }))).fetchRating('tt1'), null);
    assert.equal(await makeImdb(imdbStub(() => ({ title: null }))).fetchRating('tt1'), null);
});
test('fetchRating propagates a query failure', async () => {
    const imdb = makeImdb(imdbStub(() => new Error('boom')));
    await assert.rejects(imdb.fetchRating('tt1'), /boom/);
});

// fetchLineupInfo: the IMDb half of the published lineup info (same shapes the userscript's own cards consume).
const kf = (id, title, year, votes) => ({ node: { title: { id, titleText: { text: title }, releaseYear: { year }, ratingsSummary: { voteCount: votes } } } });
const credit = (nm, name, character, photo, knownFor = []) => ({ name: { id: nm, nameText: { text: name }, primaryImage: photo ? { url: photo } : null, knownFor: { edges: knownFor } }, characters: character ? [{ name: character }] : [] });
const PHOTO = 'https://m.media-amazon.com/images/M/abc._V1_QL75_UX280_CR0,0,280,414_.jpg';
const lineupTitle = (over = {}) => ({ title: {
    id: 'tt0103327', series: null, titleText: { text: 'Zeiram' }, releaseYear: { year: 1991 },
    ratingsSummary: { aggregateRating: 6.4, voteCount: 3100 }, runtime: { seconds: 5130 },
    plot: { plotText: { plainText: 'A bounty hunter.' } }, primaryImage: { url: 'https://m.media-amazon.com/images/M/poster.jpg' },
    titleGenres: { genres: [{ genre: { text: 'Action' } }, { genre: { text: 'Sci-Fi' } }] },
    certificate: { rating: 'Not Rated' },
    parentsGuide: { categories: [{ category: { text: 'Violence & Gore' }, severity: { text: 'Moderate' } }, { category: { text: 'Nudity' }, severity: null }] },
    stars: [{ credits: [
        credit('nm1', 'Star One', 'Iria', PHOTO, [kf('tt0103327', 'Zeiram', 1991, 9000), kf('tt9', 'Other A', 1990, 10), kf('tt8', 'Other B', 1989, 500)]),
        credit('nm2', 'Star Two', null, null),
        credit('nm3', 'Star Three', 'Bob', PHOTO),
        credit('nm4', 'Star Four', 'Fourth', PHOTO),
    ] }],
    cast: { edges: [{ node: credit('nm9', 'Fallback Actor', 'Fb', PHOTO) }] },
    ...over,
} });

test('fetchLineupInfo maps title fields, certificate, parents guide and runtime in minutes', async () => {
    const calls = [];
    const imdb = makeImdb(imdbStub(() => lineupTitle(), calls));
    const r = await imdb.fetchLineupInfo('tt0103327');
    assert.equal(calls[0].op, 'GHLineup');
    assert.deepEqual(calls[0].vars, { id: 'tt0103327' });
    assert.deepEqual({ ...r, cast: undefined }, {
        title: 'Zeiram', year: 1991, rating: 6.4, runtime: 86, overview: 'A bounty hunter.', poster: 'https://m.media-amazon.com/images/M/poster.jpg',
        genres: ['Action', 'Sci-Fi'], certificate: 'Not Rated', parentalGuide: [{ category: 'Violence & Gore', severity: 'Moderate' }], cast: undefined,
    });
});
test('fetchLineupInfo cast: principal credits first, capped at 3, headshot shrunk, most-voted known-for excluding this film', async () => {
    const r = await makeImdb(imdbStub(() => lineupTitle())).fetchLineupInfo('tt0103327');
    assert.equal(r.cast.length, 3);
    assert.deepEqual(r.cast[0], { name: 'Star One', nconst: 'nm1', character: 'Iria', photo: 'https://m.media-amazon.com/images/M/abc._V1_UX120_.jpg', knownFor: { title: 'Other B', year: 1989, tconst: 'tt8' } });
    assert.deepEqual(r.cast[1], { name: 'Star Two', nconst: 'nm2', character: null, photo: null, knownFor: null });
    assert.equal(r.cast[2].name, 'Star Three');
});
test('fetchLineupInfo falls back to credits when there are no principal credits, and tolerates missing optional fields', async () => {
    const r = await makeImdb(imdbStub(() => lineupTitle({ stars: [], certificate: null, parentsGuide: null, runtime: null, plot: null, primaryImage: null, titleGenres: null, ratingsSummary: null }))).fetchLineupInfo('tt1');
    assert.deepEqual(r.cast.map(c => c.name), ['Fallback Actor']);
    assert.deepEqual([r.certificate, r.parentalGuide, r.runtime, r.overview, r.poster, r.genres, r.rating], [null, null, null, null, null, [], null]);
});
test('fetchLineupInfo returns null for an unknown title and rejects on a query failure', async () => {
    assert.equal(await makeImdb(imdbStub(() => ({ title: null }))).fetchLineupInfo('tt0'), null);
    await assert.rejects(makeImdb(imdbStub(() => new Error('boom'))).fetchLineupInfo('tt1'), /boom/);
});
