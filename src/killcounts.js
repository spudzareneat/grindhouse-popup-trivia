// Kill counts for the Coming Attractions cards: the community Kill-Count database (one JSON object per line,
// keyed by TMDB id). The userscript used to download this in every browser; the schedule step now does it once.
import { getText } from './http.js';

export const KILLCOUNTS_URL = 'https://raw.githubusercontent.com/lklynet/Kill-Count/main/killcounts.jsonl';

// Map<string tmdbId, number count>. Blank lines, invalid JSON, and entries without a tmdb_id or a numeric count are skipped.
export function parseKillCounts(text) {
    const out = new Map();
    for (const line of String(text).split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
            const e = JSON.parse(s);
            if (e && e.tmdb_id != null && typeof e.count === 'number') out.set(String(e.tmdb_id), e.count);
        } catch { /* junk line */ }
    }
    return out;
}

// Never throws: any failure is an empty map, so a kill-count outage only blanks that one field.
export async function fetchKillCounts(fetchImpl = fetch) {
    try { return parseKillCounts(await getText(fetchImpl, KILLCOUNTS_URL)); } catch { return new Map(); }
}
