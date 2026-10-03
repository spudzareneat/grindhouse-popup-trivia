// Fuzzy title comparison, ported from the userscript's movie-title-links module so the
// generator and the client agree on what "the same title" means.

const ROMAN_NUMERALS = {
    ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9,
    xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15,
    xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
};

export function normalizeTitle(s) {
    return (s || '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/^(the|a|an)\s+/, '')
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .map(w => ROMAN_NUMERALS[w] !== undefined ? String(ROMAN_NUMERALS[w]) : w)
        .join(' ');
}

const TITLE_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'and']);

export function titleTokens(s) {
    return new Set(normalizeTitle(s).split(' ').filter(w => w && !TITLE_STOPWORDS.has(w)));
}

// Dice coefficient over normalized, stopword-stripped word sets (>= 0.7).
export function titlesMatch(a, b) {
    const setA = titleTokens(a);
    const setB = titleTokens(b);
    if (!setA.size || !setB.size) return false;
    let intersection = 0;
    for (const w of setA) if (setB.has(w)) intersection++;
    return (2 * intersection) / (setA.size + setB.size) >= 0.7;
}
