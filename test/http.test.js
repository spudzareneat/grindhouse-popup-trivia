import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getJson, getText } from '../src/http.js';

test('HTTP errors never include an api_key value (TMDB keys travel in the query string)', async () => {
    const fail = async () => ({ ok: false, status: 401 });
    await assert.rejects(getJson(fail, 'https://api.themoviedb.org/3/find/tt1?external_source=imdb_id&api_key=SECRET123'),
        err => /HTTP 401/.test(err.message) && !err.message.includes('SECRET123') && /api_key=\*\*\*/.test(err.message));
    await assert.rejects(getText(fail, 'https://api.themoviedb.org/3/search/movie?api_key=SECRET123&query=x'),
        err => !err.message.includes('SECRET123'));
});
test('other URLs keep their readable error text', async () => {
    await assert.rejects(getJson(async () => ({ ok: false, status: 500 }), 'https://example.com/a?b=1'), /HTTP 500 for https:\/\/example\.com\/a\?b=1/);
});
