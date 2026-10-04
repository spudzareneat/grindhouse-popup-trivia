// r/420Grindhouse weekend schedule: fetch the Atom feed, pick the current schedule
// post, parse days -> sections -> "Title (Year)" items. Ported from the userscript's
// tonights-lineup module (see its comments for the live-confirmed quirks handled here:
// pinned-order != recency, "==Friday==" decorated headers, "(1998))" typo parens).

export const FEED_URL = 'https://www.reddit.com/r/420Grindhouse/.rss';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DAY_NAMES = ['Friday', 'Saturday', 'Sunday'];
const CANDIDATE_SCAN_LIMIT = 5;

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
    for (const entry of entries.slice(0, CANDIDATE_SCAN_LIMIT)) {
        if (!parseDateRange(entry.title, entry.publishedAt)) continue;
        if (!best || new Date(entry.publishedAt) > new Date(best.publishedAt)) best = entry;
    }
    return best;
}

export function parseListItems(ulInnerHtml) {
    const items = [];
    const liRe = /<li>([\s\S]*?)<\/li>/g;
    let lm;
    while ((lm = liRe.exec(ulInnerHtml))) {
        const display = lm[1].replace(/<strong>[^<]*<\/strong>\s*/, '').replace(/<[^>]+>/g, '').trim();
        if (!display) continue;
        const [primary, ...akaParts] = display.split(/\s+aka\s+/i);
        const akas = akaParts.map(a => a.replace(/\s*\(\d{4}\)\s*$/, '').trim()).filter(Boolean);
        const ym = primary.trim().match(/^(.*?)\s*\((\d{4})\)/);
        if (ym) items.push({ title: ym[1].trim(), year: ym[2], display, akas });
        else items.push({ title: primary.trim(), year: null, display, akas });
    }
    return items;
}

export function parseSchedule(contentHtml) {
    const days = [];
    let currentDay = null;
    let pendingSectionName = null;
    const re = /<strong>([^<]*)<\/strong>|<ul>([\s\S]*?)<\/ul>/g;
    let m;
    while ((m = re.exec(contentHtml))) {
        if (m[1] !== undefined) {
            const text = m[1].trim();
            const dayName = text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
            if (DAY_NAMES.includes(dayName)) {
                currentDay = { day: dayName, sections: [] };
                days.push(currentDay);
                pendingSectionName = null;
            } else {
                pendingSectionName = text;
            }
        } else if (currentDay && pendingSectionName) {
            const items = parseListItems(m[2]);
            if (items.length) currentDay.sections.push({ name: pendingSectionName, slug: slugify(pendingSectionName), items });
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

export async function fetchWeekendMovies(fetchImpl = fetch) {
    const res = await fetchImpl(FEED_URL, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('Reddit feed HTTP ' + res.status);
    const entry = selectCurrentEntry(parseEntries(await res.text()));
    if (!entry) throw new Error('no schedule post found in feed');
    const days = parseSchedule(entry.contentHtml);
    if (!days.length) throw new Error('no days parsed from schedule post: ' + entry.title);
    return { postTitle: entry.title, weekendFri: parseDateRange(entry.title, entry.publishedAt).fri, movies: flattenMovies(days) };
}
