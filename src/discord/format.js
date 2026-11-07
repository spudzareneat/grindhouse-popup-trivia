// Pure message builders for the Discord summary and picker. No I/O.

const BUDGET = 4000;
const MAX_CANDIDATES = 5;
const BUTTONS_PER_ROW = 5;
const LABEL_MAX = 80;
const REASON_MAX = 300;
const REASON_MIN = 60;
const TITLE_MAX = 80;

const clip = (s, n) => {
    const chars = Array.from(String(s ?? ''));
    return chars.length <= n ? chars.join('') : `${chars.slice(0, n - 1).join('')}…`;
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

function needsLine(r, reasonMax) {
    const title = clip(r.title, TITLE_MAX);
    if (r.status === 'failed') return `• **${title}**: ${clip(r.reason ?? 'failed', reasonMax)}`;
    const mt = r.match;
    return `• **${title}**: unsure match, used ${clip(mt.matchedTitle ?? '?', TITLE_MAX)}${year(mt.matchedYear)}`;
}

function doneLine(r) {
    const mt = r.match;
    const name = mt?.matchedTitle ? `${mt.matchedTitle}${year(mt.matchedYear)}` : r.title;
    const facts = r.kept != null ? `, ${r.kept} facts` : '';
    const via = mt?.source === 'tmdb' ? ' via TMDB' : '';
    return `• ${name}${facts}${via}`;
}

const skippedLine = (r) => `• ${clip(r.title, TITLE_MAX)}${r.reason ? `: ${clip(r.reason, REASON_MAX)}` : ''}`;

export function buildSummary(results, { postTitle = null } = {}) {
    const needsRes = [];
    const done = [];
    const skipped = [];
    const stops = [];
    for (const r of results) {
        if (r.stop) stops.push(r.stop);
        if (r.status === 'failed' || r.match?.confidence === 'unsure') needsRes.push(r);
        else if (r.status === 'done') done.push(doneLine(r));
        else if (r.status === 'skipped') skipped.push(skippedLine(r));
    }

    const stopNote = stops.length
        ? `**Run stopped**: ${stops.includes('usage') ? 'Claude usage limit or auth failure' : 'publish (git push) failure'}. Remaining movies were not processed.`
        : null;

    const others = done.length + skipped.length;
    // Degradation order: drop Done/Skipped lines, then shrink Needs reasons, then drop whole Needs lines.
    const render = (reasonMax, keepNeeds, keepOthers) => {
        const needs = needsRes.slice(0, keepNeeds).map((r) => needsLine(r, reasonMax));
        const keepDone = Math.min(done.length, keepOthers);
        const keepSkipped = keepOthers - keepDone;
        const parts = [];
        if (needs.length) parts.push(['**Needs a look**', ...needs].join('\n'));
        if (keepDone) parts.push(['**Done**', ...done.slice(0, keepDone)].join('\n'));
        if (keepSkipped) parts.push(['**Skipped**', ...skipped.slice(0, keepSkipped)].join('\n'));
        if (stopNote) parts.push(stopNote);
        const dropped = (needsRes.length - keepNeeds) + (others - keepOthers);
        if (dropped) parts.push(`...and ${dropped} more`);
        return parts.join('\n\n');
    };
    const fits = (t) => t.length <= BUDGET;

    let text = render(REASON_MAX, needsRes.length, others);
    if (!fits(text)) {
        // Largest reason clip at which Needs fits with Done/Skipped fully collapsed.
        let reasonMax = REASON_MAX;
        while (reasonMax > REASON_MIN && !fits(render(reasonMax, needsRes.length, 0))) reasonMax -= 10;
        let keepNeeds = needsRes.length;
        while (keepNeeds > 0 && !fits(render(reasonMax, keepNeeds, 0))) keepNeeds--;
        // Keep as many Done/Skipped lines as still fit.
        let keepOthers = others;
        while (keepOthers > 0 && !fits(render(reasonMax, keepNeeds, keepOthers))) keepOthers--;
        text = render(reasonMax, keepNeeds, keepOthers);
    }
    if (!text) text = 'No movies processed.';

    return {
        embeds: [{
            title: postTitle ? `Trivia run: ${postTitle}` : 'Trivia run',
            description: text,
            color: needsRes.length ? 0xe67e22 : stops.length ? 0xe74c3c : 0x2ecc71,
        }],
    };
}

export function buildPicker(entry) {
    const buttons = (entry.candidates ?? []).slice(0, MAX_CANDIDATES).map((c) => {
        const mark = c.tconst === entry.guessTconst ? '✓ ' : '';
        return {
            type: 2,
            style: 1,
            label: clip(`${mark}${c.title}${year(c.year)}${c.source ? ` · ${c.source}` : ''}`, LABEL_MAX),
            custom_id: `pick:${entry.id}:${c.tconst}`,
        };
    });
    buttons.push({ type: 2, style: 2, label: 'None of these', custom_id: `pick:${entry.id}:none` });
    // Discord allows at most 5 buttons per action row (more is an HTTP 400 for the whole message), so
    // 5 candidates + "None of these" goes over two rows.
    const rows = [];
    for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) rows.push({ type: 1, components: buttons.slice(i, i + BUTTONS_PER_ROW) });
    return {
        content: clip(`Which film is "${entry.scheduleTitle}"${year(entry.scheduleYear)}?`, 2000),
        components: rows,
    };
}

export function parsePickId(customId) {
    if (typeof customId !== 'string') return null;
    const m = /^pick:([^:]+):([^:]+)$/.exec(customId);
    if (!m) return null;
    return { id: m[1], tconst: m[2] === 'none' ? null : m[2] };
}
