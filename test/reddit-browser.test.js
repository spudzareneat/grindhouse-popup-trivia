import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCookies, readCookiesFile, fetchWeekendMoviesViaBrowser, RedditSessionError } from '../src/reddit-browser.js';

const BODY = '<p>Intro</p><p><strong>Friday</strong></p><p><strong>Creature Feature</strong></p>' +
    '<ul><li>Carnival of Souls (1962)</li><li>Alligator (1980) aka Alligator: The Bite</li></ul>' +
    '<p><strong>Saturday</strong></p><p><strong>Late Show</strong></p><ul><li>Don\'t Look in the Basement (1973)</li></ul>';
const LISTING = [
    { postId: 't3_old', title: 'Weekend Grindhouse Schedule - Fri 9/26 - Sun 9/28', publishedAt: '2026-09-22T12:00:00+00:00', permalink: '/r/420Grindhouse/comments/old/x/' },
    { postId: 't3_new', title: 'Weekend Grindhouse Schedule - Fri 10/3 - Sun 10/5', publishedAt: '2026-09-30T12:00:00+00:00', permalink: '/r/420Grindhouse/comments/new/x/' },
    { postId: 't3_x', title: 'Random post', publishedAt: '2026-10-01T00:00:00+00:00', permalink: '/r/420Grindhouse/comments/x/x/' },
];

// Fake Playwright: evaluate() dispatches on the in-page function, since there is no DOM here.
function fakeLaunch({ listing = LISTING, body = BODY, loginWall = false, urls = [], added = [] } = {}) {
    let closed = false;
    const page = {
        _url: '',
        url() { return this._url; },
        setDefaultNavigationTimeout() {},
        async goto(u) { urls.push(u); this._url = u; },
        async title() { return 'reddit'; },
        async evaluate(fn) { return fn.name === 'readListing' ? listing : fn.name === 'readBody' ? body : loginWall; },
    };
    const browser = { newContext: async () => ({ addCookies: async c => { added.push(...c); }, newPage: async () => page }), close: async () => { closed = true; }, get closed() { return closed; } };
    return async () => browser;
}
function cookieFile(json) {
    const f = join(mkdtempSync(join(tmpdir(), 'rb-')), 'c.json');
    writeFileSync(f, typeof json === 'string' ? json : JSON.stringify(json));
    return f;
}
const COOKIES = [{ name: 'reddit_session', value: 'SECRET', domain: '.reddit.com', path: '/', secure: true, httpOnly: true, expirationDate: 1900000000.5, sameSite: 'no_restriction' },
    { name: 'other', value: 'x', domain: 'example.com', path: '/' }];

test('normalizeCookies converts an export to Playwright cookies and drops non-reddit ones', () => {
    const [c, ...rest] = normalizeCookies(COOKIES);
    assert.equal(rest.length, 0);
    assert.deepEqual(c, { name: 'reddit_session', value: 'SECRET', domain: '.reddit.com', path: '/', secure: true, httpOnly: true, expires: 1900000000, sameSite: 'None' });
});
test('cookie file errors are explicit and never include cookie values', () => {
    assert.throws(() => readCookiesFile('/nope/missing.json'), RedditSessionError);
    assert.throws(() => readCookiesFile(cookieFile('not json SECRET')), err => err instanceof RedditSessionError && !err.message.includes('SECRET'));
    assert.throws(() => normalizeCookies([{ name: 'a', value: 'b', domain: 'example.com' }]), /no reddit\.com cookies/);
    assert.throws(() => normalizeCookies([]), RedditSessionError);
});
test('fetches the newest schedule post and parses it with the existing parser', async () => {
    const urls = [], added = [];
    const r = await fetchWeekendMoviesViaBrowser({ cookiesFile: cookieFile(COOKIES), launch: fakeLaunch({ urls, added }) });
    assert.equal(r.postTitle, 'Weekend Grindhouse Schedule - Fri 10/3 - Sun 10/5');
    assert.deepEqual(r.movies.map(m => m.title), ['Carnival of Souls', 'Alligator', "Don't Look in the Basement"]);
    assert.equal(urls[0], 'https://old.reddit.com/r/420Grindhouse/new');
    assert.equal(urls[1], 'https://old.reddit.com/r/420Grindhouse/comments/new/x/');
    assert.equal(added.length, 1);
});
test('a login wall is reported as an expired session and the browser is still closed', async () => {
    const launch = fakeLaunch({ loginWall: true });
    await assert.rejects(fetchWeekendMoviesViaBrowser({ cookiesFile: cookieFile(COOKIES), launch }), err => err instanceof RedditSessionError && /re-export the cookies/.test(err.message));
    assert.equal((await launch()).closed, true);
});
test('no schedule post, an empty listing or an empty body fail with readable errors', async () => {
    const f = cookieFile(COOKIES);
    await assert.rejects(fetchWeekendMoviesViaBrowser({ cookiesFile: f, launch: fakeLaunch({ listing: [LISTING[2]] }) }), /no schedule post found/);
    await assert.rejects(fetchWeekendMoviesViaBrowser({ cookiesFile: f, launch: fakeLaunch({ listing: [] }) }), /no posts/);
    await assert.rejects(fetchWeekendMoviesViaBrowser({ cookiesFile: f, launch: fakeLaunch({ body: '' }) }), /no readable body/);
});
