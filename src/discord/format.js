// Pure message builders for the Discord summary and picker. No I/O.

const BUDGET = 4000;
const MAX_CANDIDATES = 5;
const LABEL_MAX = 80;
const REASON_MAX = 300;

const clip = (s, n) => {
    s = String(s ?? '');
    return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
};

const year = (y) => (y ? ` (${y})` : '');

export function needsPicker(result) {
    const match = result?.match;
    if (!match) return false;
    if (match.confidence === 'unsure') return true;
    return result.status === 'failed'
        && /not found on IMDb/i.test(result.reason ?? '')
        && (match.candidates?.length ?? 0) > 0;
}

function needsLine(r) {
    if (r.status === 'failed') return `• **${r.title}**: ${clip(r.reason ?? 'failed', REASON_MAX)}`;
    const mt = r.match;
    return `• **${r.title}**: unsure match, used ${mt.matchedTitle ?? '?'}${year(mt.matchedYear)}`;
}

function doneLine(r) {
    const mt = r.match;
    const name = mt?.matchedTitle ? `${mt.matchedTitle}${year(mt.matchedYear)}` : r.title;
    const facts = r.kept != null ? `, ${r.kept} facts` : '';
    const via = mt?.source === 'tmdb' ? ' via TMDB' : '';
    return `• ${name}${facts}${via}`;
}

const skippedLine = (r) => `• ${r.title}${r.reason ? `: ${clip(r.reason, REASON_MAX)}` : ''}`;

export function buildSummary(results, { postTitle = null } = {}) {
    const needs = [];
    const done = [];
    const skipped = [];
    const stops = [];
    for (const r of results) {
        if (r.stop) stops.push(r.stop);
        if (r.status === 'failed' || r.match?.confidence === 'unsure') needs.push(needsLine(r));
        else if (r.status === 'done') done.push(doneLine(r));
        else if (r.status === 'skipped') skipped.push(skippedLine(r));
    }

    const stopNote = stops.length
        ? `**Run stopped**: ${stops.includes('usage') ? 'Claude usage limit or auth failure' : 'publish (git push) failure'}. Remaining movies were not processed.`
        : null;

    // Droppable lines: Done then Skipped, cut from the end. Needs a look is never cut.
    const render = (drop) => {
        const keepTotal = done.length + skipped.length - drop;
        const keepDone = Math.min(done.length, keepTotal);
        const keepSkipped = keepTotal - keepDone;
        const parts = [];
        if (needs.length) parts.push(['**Needs a look**', ...needs].join('\n'));
        if (keepDone) parts.push(['**Done**', ...done.slice(0, keepDone)].join('\n'));
        if (keepSkipped) parts.push(['**Skipped**', ...skipped.slice(0, keepSkipped)].join('\n'));
        if (stopNote) parts.push(stopNote);
        if (drop) parts.push(`...and ${drop} more`);
        return parts.join('\n\n');
    };

    const total = done.length + skipped.length;
    let drop = 0;
    let text = render(0);
    while (text.length > BUDGET && drop < total) text = render(++drop);
    if (text.length > BUDGET) text = `${text.slice(0, BUDGET - 15).trimEnd()}\n...and more`; // needs alone overflowed
    if (!text) text = 'No movies processed.';

    return {
        embeds: [{
            title: postTitle ? `Trivia run: ${postTitle}` : 'Trivia run',
            description: text,
            color: needs.length ? 0xe67e22 : stops.length ? 0xe74c3c : 0x2ecc71,
        }],
    };
}

export function buildPicker(entry) {
    const buttons = (entry.candidates ?? []).slice(0, MAX_CANDIDATES).map((c) => {
        const mark = c.tconst === entry.guessTconst ? '✓ ' : '';
        return {
            type: 2,
            style: 1,
            label: clip(`${mark}${c.title}${year(c.year)} · ${c.source}`, LABEL_MAX),
            custom_id: `pick:${entry.id}:${c.tconst}`,
        };
    });
    buttons.push({ type: 2, style: 2, label: 'None of these', custom_id: `pick:${entry.id}:none` });
    return {
        content: clip(`Which film is "${entry.scheduleTitle}"${year(entry.scheduleYear)}?`, 2000),
        components: [{ type: 1, components: buttons }],
    };
}

export function parsePickId(customId) {
    if (typeof customId !== 'string') return null;
    const m = /^pick:([^:]+):([^:]+)$/.exec(customId);
    if (!m) return null;
    return { id: m[1], tconst: m[2] === 'none' ? null : m[2] };
}
