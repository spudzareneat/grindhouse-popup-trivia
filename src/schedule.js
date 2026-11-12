// r/420Grindhouse weekend schedule: fetch the Atom feed, pick the current schedule
// post, parse days -> sections -> "Title (Year)" items. Ported from the userscript's
// tonights-lineup module (see its comments for the live-confirmed quirks handled here:
// pinned-order != recency, "==Friday==" decorated headers, "(1998))" typo parens,
// themed "==Halloween Eve Friday==" day headers, tags nested inside <strong> headers).

import { readFileSync } from 'node:fs';
import { minimalFetch } from './http.js';

export const FEED_URL = 'https://www.reddit.com/r/420Grindhouse/.rss';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DAY_NAMES = ['Friday', 'Saturday', 'Sunday'];

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function decodeHtmlEntities(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

export function parseEntries(feedXml) {
    const entries = [];
    let searchFrom = 0;
    while (true) {
        const start = feedXml.indexOf('<entry>', searchFrom);
        if (start === -1) break;
        const end = feedXml.indexOf('</entry>', start);
        if (end === -1) break;
        const entry = feedXml.slice(start, end + '</entry>'.length);
        searchFrom = end + '</entry>'.length;
        const idM = entry.match(/<id>([^<]+)<\/id>/);
        const titleM = entry.match(/<title>([^<]+)<\/title>/);
        const contentM = entry.match(/<content type="html">([\s\S]*?)<\/content>/);
        if (!idM || !titleM || !contentM) continue;
        const pubM = entry.match(/<published>([^<]+)<\/published>/);
        entries.push({
            postId: idM[1],
            title: decodeHtmlEntities(titleM[1]),
            publishedAt: pubM ? pubM[1] : null,
            contentHtml: decodeHtmlEntities(contentM[1]),
        });
    }
    return entries;
}

export function parseDateRange(title, publishedAt) {
    const m = title && title.match(/Fri\D*(\d{1,2})\/(\d{1,2})/i);
    if (!m || !publishedAt) return null;
    const pub = new Date(publishedAt);
    if (isNaN(pub.getTime())) return null;
    const friMonth = parseInt(m[1], 10), friDay = parseInt(m[2], 10);
    const pubMonth = pub.getMonth() + 1;
    const year = (pubMonth === 12 && friMonth === 1) ? pub.getFullYear() + 1 : pub.getFullYear();
    const fri = Date.UTC(year, friMonth - 1, friDay);
    const toStr = (ms) => new Date(ms).toISOString().slice(0, 10);
    return { fri: toStr(fri), sat: toStr(fri + 86400000), sun: toStr(fri + 2 * 86400000) };
}

export function selectCurrentEntry(entries) {
    let best = null;
    // Whole feed, not just the top few: pin order isn't recency, and the scan costs nothing here.
    for (const entry of entries) {
        if (!parseDateRange(entry.title, entry.publishedAt)) continue;
        if (!best || new Date(entry.publishedAt) > new Date(best.publishedAt)) best = entry;
    }
    return best;
}

// Year typos seen across two years of posts: "Decampitated (1998))", "Jason X )2001)",
// "...Family Reunion [2003]", "A Wrestling Christmas Miracle (2020", "Fit to Kill 1993)".
// A year with no bracket on either side stays part of the title ("Equalizer 2000 (1987)",
// aka "Holocaust 2000").
const BRACKETED_YEAR_RE = /^(.*?)\s*[(\[)]\s*((?:18|19|20)\d{2})\s*[)\]]?/;
const CLOSE_ONLY_YEAR_RE = /^(.*\S)\s+((?:18|19|20)\d{2})\s*[)\]]+/;
const TRAILING_YEAR_RE = /\s*(?:[(\[)]\s*\d{4}\s*[)\]]*|\d{4}\s*[)\]]+)\s*$/;

export function parseListItems(ulInnerHtml) {
    const items = [];
    const liRe = /<li>([\s\S]*?)<\/li>/g;
    let lm;
    while ((lm = liRe.exec(ulInnerHtml))) {
        // Second decode: Reddit entity-encodes '&' inside the already-escaped feed blob,
        // so "Judge & Jury" is still "Judge &amp; Jury" after parseEntries' pass.
        const display = decodeHtmlEntities(lm[1].replace(/<strong>[^<]*<\/strong>\s*/, '').replace(/<[^>]+>/g, '')).trim();
        if (!display) continue;
        const [primary, ...akaParts] = display.split(/\s+aka\s+/i);
        const akas = akaParts.map(a => a.replace(TRAILING_YEAR_RE, '').trim()).filter(Boolean);
        const p = primary.trim();
        const ym = p.match(BRACKETED_YEAR_RE) || p.match(CLOSE_ONLY_YEAR_RE);
        if (ym) items.push({ title: ym[1].trim(), year: ym[2], display, akas });
        else items.push({ title: p, year: null, display, akas });
    }
    return items;
}

export function parseSchedule(contentHtml) {
    const days = [];
    let currentDay = null;
    let pendingSectionName = null;
    // [\s\S]*? + tag strip: a header can nest tags inside the bold ("<strong><em>Halloween
    // Raffle Winners Reveal</em></strong>", 2026-10-30 -- was skipped, dropping its film).
    const re = /<strong>([\s\S]*?)<\/strong>|<ul>([\s\S]*?)<\/ul>/g;
    let m;
    while ((m = re.exec(contentHtml))) {
        if (m[1] !== undefined) {
            const text = m[1].replace(/<[^>]+>/g, '').trim();
            const cleaned = text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
            let dayName = DAY_NAMES.includes(cleaned) ? cleaned : null;
            // Themed day headers add words ("==Halloween Eve Friday==", 2026-10-30). Section
            // names contain day names too ("Funky Cheese Friday"), so tell them apart by
            // structure: a section header is followed by its <ul>, a day header by another bold.
            if (!dayName) {
                const words = DAY_NAMES.filter(d => new RegExp(`\\b${d}\\b`, 'i').test(cleaned));
                const rest = contentHtml.slice(re.lastIndex);
                const nextUl = rest.indexOf('<ul>'), nextStrong = rest.indexOf('<strong>');
                if (words.length === 1 && nextStrong !== -1 && (nextUl === -1 || nextStrong < nextUl)) dayName = words[0];
            }
            if (dayName) {
                currentDay = { day: dayName, sections: [] };
                days.push(currentDay);
                pendingSectionName = null;
            } else {
                pendingSectionName = text;
            }
        } else {
            // A list with no section header (or before any day header) used to be dropped
            // silently, and a dropped film never gets trivia. Keep it: an unlabeled list takes
            // the day's name as its section; a list before any day goes under "Unknown", dated
            // items only, so a list of links in an intro doesn't turn into movies.
            let items = parseListItems(m[2]);
            if (!currentDay) {
                items = items.filter(it => it.year);
                if (items.length) { currentDay = { day: 'Unknown', sections: [] }; days.push(currentDay); }
            }
            const name = pendingSectionName || currentDay?.day;
            if (currentDay && items.length) currentDay.sections.push({ name, slug: slugify(name), items });
            pendingSectionName = null;
        }
    }
    return days;
}

// One entry per distinct (title, year) across the whole weekend, in schedule order.
// block: the section's position within its night (0 = first block); a film shown twice keeps its earliest.
export function flattenMovies(days) {
    const seen = new Map();
    const out = [];
    for (const d of days) d.sections.forEach((s, block) => { for (const it of s.items) {
        const key = `${it.title.toLowerCase()}|${it.year ?? ''}`;
        if (seen.has(key)) { const m = seen.get(key); m.block = Math.min(m.block, block); continue; }
        const m = { title: it.title, year: it.year ? Number(it.year) : null, akas: it.akas, day: d.day, section: s.name, block };
        seen.set(key, m);
        out.push(m);
    } });
    return out;
}

function scheduleFromFeed(feedXml) {
    const entry = selectCurrentEntry(parseEntries(feedXml));
    if (!entry) throw new Error('no schedule post found in feed');
    const days = parseSchedule(entry.contentHtml);
    if (!days.length) throw new Error('no days parsed from schedule post: ' + entry.title);
    return { postTitle: entry.title, weekendFri: parseDateRange(entry.title, entry.publishedAt).fri, movies: flattenMovies(days) };
}

// Manual override for when Reddit blocks the server: the feed XML saved from a browser
// (open the FEED_URL, Save As). Same parsing as the live feed.
export function readWeekendMoviesFile(file) {
    return scheduleFromFeed(readFileSync(file, 'utf8'));
}

// Only a 429 (rate limited) is retried, and politely: wait what Reddit asks (capped), a few times.
// A 403 is a block, not a rate limit, so it fails straight away instead of hammering the server.
// REDDIT_FEED_URL: the personal feed URL from reddit.com/prefs/feeds (any listing, e.g. .../.rss?feed=GUID&user=NAME).
// Its feed/user params are applied to the subreddit feed so the request is authenticated like a feed reader's.
// Unset -> the public URL. Never logged: the token is a credential.
export function feedUrl(env = process.env) {
    const raw = env.REDDIT_FEED_URL;
    if (!raw) return FEED_URL;
    const u = new URL(FEED_URL);
    const src = new URL(raw);
    for (const k of ['feed', 'user']) if (src.searchParams.has(k)) u.searchParams.set(k, src.searchParams.get(k));
    return u.href;
}

// First readable words of an error page (Reddit's 403 is a full HTML page that says why).
function bodyHint(html) {
    return html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

const MAX_429_RETRIES = 3;
const MAX_WAIT_MS = 90000;
export async function fetchWeekendMovies(fetchImpl = minimalFetch, { sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {} } = {}) {
    // minimalFetch, not the global fetch: Reddit 403s Node's fetch from this server but serves a bare request.
    const url = feedUrl();
    for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(20000) });
        if (res.ok) return scheduleFromFeed(await res.text());
        if (res.status !== 429 || attempt >= MAX_429_RETRIES) {
            const hint = bodyHint(await res.text().catch(() => ''));
            throw new Error('Reddit feed HTTP ' + res.status + (hint ? ` — ${hint}` : '') + (url === FEED_URL ? ' (public feed; set REDDIT_FEED_URL)' : ''));
        }
        const hinted = Number(res.headers?.['retry-after'] ?? res.headers?.['x-ratelimit-reset']);
        const waitMs = Math.min(MAX_WAIT_MS, (Number.isFinite(hinted) && hinted > 0 ? hinted : 15 * 2 ** attempt) * 1000);
        log(`Reddit feed HTTP 429 — retrying in ${Math.round(waitMs / 1000)}s (${attempt + 1}/${MAX_429_RETRIES})`);
        await sleep(waitMs);
    }
}
