import { getText } from './http.js';
import { titlesMatch } from './titles.js';

// Joe Bob Briggs' Drive-In Totals, transcribed in spudzareneat/DriveInTotals.
export const TOTALS_CSV_URL = 'https://raw.githubusercontent.com/spudzareneat/DriveInTotals/main/drivein_totals.csv';

// Minimal RFC 4180 parser: quoted fields, "" escapes, embedded commas/newlines, CRLF.
export function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') inQuotes = false;
            else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); rows.push(row); row = []; field = '';
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

export function parseTotals(text) {
    const [header, ...rows] = parseCsv(text);
    const col = name => header.indexOf(name);
    const ti = col('title'), yi = col('year'), di = col('description');
    return rows
        .map(r => ({ title: (r[ti] || '').trim(), year: /^\d{4}$/.test((r[yi] || '').trim()) ? Number(r[yi]) : null, description: (r[di] || '').trim() }))
        .filter(r => r.title && r.description);
}

// With a year: exact year first, then +-1. Without a year: only when exactly one
// row has that title (never guess between e.g. The Fly 1958 and 1986).
export function findTotals(rows, title, year) {
    const hits = rows.filter(r => titlesMatch(r.title, title));
    if (!hits.length) return null;
    if (year) {
        const exact = hits.find(r => r.year === year);
        if (exact) return exact.description;
        const near = hits.find(r => r.year && Math.abs(r.year - year) <= 1);
        return near ? near.description : null;
    }
    return hits.length === 1 ? hits[0].description : null;
}

export async function fetchTotals(fetchImpl = fetch) {
    return parseTotals(await getText(fetchImpl, TOTALS_CSV_URL));
}
