// One-off: save past r/420Grindhouse schedule posts as parser test fixtures.
//
//   node scripts/fetch-schedule-corpus.js [pages=1]
//
// Reddit's search RSS returns up to 100 posts per page (about two years of weekly
// schedules); pass a larger page count to follow its `after=` link further back.
// Writes test/fixtures/schedule-corpus/<published-date>-<postId>.json; existing files are overwritten.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEntries, parseDateRange } from '../src/schedule.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://www.reddit.com/r/420Grindhouse/search.rss?q=title%3Aschedule&restrict_sr=1&sort=new&limit=100';
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'schedule-corpus');

const pages = Number(process.argv[2] || 1);
fs.mkdirSync(outDir, { recursive: true });
let url = BASE, saved = 0;
for (let p = 0; p < pages && url; p++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const xml = await res.text();
    for (const e of parseEntries(xml)) {
        if (!parseDateRange(e.title, e.publishedAt)) continue;   // not a weekend schedule post
        const file = `${e.publishedAt.slice(0, 10)}-${e.postId}.json`;
        fs.writeFileSync(path.join(outDir, file), JSON.stringify(e, null, 1) + '\n');
        saved++;
    }
    const next = xml.match(/<link rel="next" href="([^"]+)"/);
    url = next ? next[1].replace(/&amp;/g, '&') : null;
}
console.log(`saved ${saved} posts to ${outDir}`);
