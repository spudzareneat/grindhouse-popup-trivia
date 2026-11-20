// Reddit ended RSS on 2026-11-13 and blocks plain HTTP clients, so the schedule is read the way a
// person reads it: headless Chromium carrying a logged-in session exported from a normal browser.
// Never log cookie values: they are credentials.

import { readFileSync } from 'node:fs';
import { parseDateRange, scheduleFromEntries } from './schedule.js';

export const LISTING_URL = 'https://old.reddit.com/r/420Grindhouse/new';
const NAV_TIMEOUT_MS = 45000;
// Matches the Chromium that playwright-core 1.49 bundles (131).
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class RedditSessionError extends Error {}

const SAMESITE = { strict: 'Strict', lax: 'Lax', no_restriction: 'None', none: 'None' };

// Accepts a Cookie-Editor / EditThisCookie style JSON export (array) or Playwright's own format.
export function normalizeCookies(raw) {
    if (!Array.isArray(raw) || !raw.length) throw new RedditSessionError('Reddit cookie file must be a non-empty JSON array of cookies');
    const out = raw.filter(c => /(^|\.)reddit\.com$/.test(String(c.domain || '').replace(/^\./, '')) || /reddit\.com$/.test(String(c.domain || '')))
        .map(c => {
            if (!c.name || c.value === undefined) throw new RedditSessionError('Reddit cookie file has an entry without name/value');
            const cookie = { name: c.name, value: String(c.value), domain: c.domain, path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly };
            const exp = c.expires ?? c.expirationDate;
            if (typeof exp === 'number' && exp > 0) cookie.expires = Math.floor(exp);
            const ss = SAMESITE[String(c.sameSite || '').toLowerCase()];
            if (ss) cookie.sameSite = ss;
            return cookie;
        });
    if (!out.length) throw new RedditSessionError('Reddit cookie file has no reddit.com cookies');
    return out;
}

export function readCookiesFile(file) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { throw new RedditSessionError(`Reddit cookie file not found at ${file}`); }
    let json;
    try { json = JSON.parse(text); } catch { throw new RedditSessionError('Reddit cookie file is not valid JSON'); }
    return normalizeCookies(json);
}

// Runs in the page: one record per post in the old.reddit listing.
function readListing() {
    return [...document.querySelectorAll('#siteTable > div.thing[data-fullname]')].map(el => ({
        postId: el.getAttribute('data-fullname'),
        title: (el.querySelector('a.title')?.textContent || '').trim(),
        publishedAt: el.querySelector('time[datetime]')?.getAttribute('datetime') || null,
        permalink: el.getAttribute('data-permalink'),
    }));
}
function readBody() {
    return document.querySelector('#siteTable div.thing.link div.usertext-body div.md')?.innerHTML || '';
}

// A login redirect, or a listing page that has no posts and a login form, means the cookies are dead.
async function assertLoggedIn(page, where) {
    const url = page.url();
    const loginWall = /\/login|\/account\/login/.test(url) || await page.evaluate(() => !!document.querySelector('form#login-form, form.login-form') || /must be logged in|log in or sign up/i.test(document.body?.innerText?.slice(0, 600) || ''));
    if (loginWall) throw new RedditSessionError(`Reddit session expired or rejected at ${where}: re-export the cookies from a logged-in browser`);
}

export async function fetchWeekendMoviesViaBrowser({ cookiesFile = process.env.REDDIT_COOKIES_FILE || '/secrets/reddit_cookies.json', launch, log = () => {} } = {}) {
    const cookies = readCookiesFile(cookiesFile);
    launch ??= async () => (await import('playwright-core')).chromium.launch({ args: ['--no-sandbox'] });
    const browser = await launch();
    try {
        // Headless Chromium's default UA says "HeadlessChrome", which Reddit answers with a 403 "blocked by network security"
        // even with a valid session (verified 2026-11-19: same cookies, UA changed, 200 and a full listing).
        const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 }, userAgent: CHROME_UA });
        await context.addCookies(cookies);
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

        await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded' });
        await assertLoggedIn(page, 'the listing');
        const listing = await page.evaluate(readListing);
        log(`reddit: ${listing.length} posts in listing`);
        if (!listing.length) throw new Error(`Reddit listing had no posts (page: ${(await page.title()).slice(0, 80)})`);

        // Same pick as the RSS path: the newest post whose title carries a "Fri m/d" range.
        const candidates = listing.filter(p => p.permalink && parseDateRange(p.title, p.publishedAt));
        candidates.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
        const current = candidates[0];
        if (!current) throw new Error('no schedule post found in the Reddit listing');

        await page.goto(new URL(current.permalink, LISTING_URL).href, { waitUntil: 'domcontentloaded' });
        await assertLoggedIn(page, 'the schedule post');
        const contentHtml = await page.evaluate(readBody);
        if (!contentHtml) throw new Error('schedule post had no readable body: ' + current.title);
        return scheduleFromEntries([{ ...current, contentHtml }]);
    } finally {
        await browser.close().catch(() => {});
    }
}
