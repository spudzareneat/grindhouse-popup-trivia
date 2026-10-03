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
