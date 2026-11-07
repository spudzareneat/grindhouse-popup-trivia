// Posts the run summary and one picker per movie needing a human decision. Never throws.
import path from 'node:path';
import { buildSummary, buildPicker, needsPicker } from './format.js';
import { overrideKey } from '../overrides.js';

const FAIL_MAX = 500;

// `dismissed` is the overrides file's dismissed map; `dataDir` locates the guess file of an already-published title.
export async function notifyRun({ api, store, results, postTitle = null, dismissed = {}, dataDir = null, log = () => {} }) {
    const warn = (what, e) => { try { log(`Discord: ${what} failed: ${e?.message ?? e}`); } catch { /* ignore */ } };
    try {
        await api.postMessage(buildSummary(results, { postTitle }));
    } catch (e) { warn('summary post', e); }
    try {
        for (const r of results ?? []) {
            let id = null;
            try {
                if (!needsPicker(r)) continue;
                const m = r.match;
                const key = overrideKey(m.scheduleTitle, m.scheduleYear);
                if (dismissed?.[key]) continue;
                // One picker per title: a later run must not stack a second one on an unanswered first.
                // An entry with no message id never reached Discord (its post failed), so nobody can answer it.
                if (store.list().some(e => e.messageId && (e.status === 'open' || e.status === 'running') && overrideKey(e.scheduleTitle, e.scheduleYear) === key)) continue;
                const published = r.status === 'done' || (r.status === 'skipped' && /already has a file/i.test(r.reason ?? ''));
                const guessed = published && m.confidence === 'unsure' && !!r.tconst;
                id = store.add({
                    scheduleTitle: m.scheduleTitle,
                    scheduleYear: m.scheduleYear,
                    candidates: m.candidates,
                    guessTconst: guessed ? r.tconst : null,
                    guessFile: guessed ? (r.dataFile ?? (dataDir ? path.join(dataDir, `${r.tconst}.json`) : null)) : null,
                    messageId: null,
                });
                const msg = await api.postMessage(buildPicker(store.get(id)));
                store.update(id, { messageId: msg.id });
            } catch (e) {
                warn(`picker for "${r?.title}"`, e);
                // The picker never reached the channel: don't leave an open entry nobody can answer.
                if (id) { try { store.update(id, { status: 'expired' }); } catch { /* best effort */ } }
            }
        }
    } catch (e) { warn('pickers', e); }
}

// Tells the channel a whole run died (feed down, git failure, ...). Never throws.
export async function notifyFailure({ api, error, log = () => {} }) {
    try {
        const text = String(error?.message ?? error ?? 'unknown error').slice(0, FAIL_MAX);
        await api.postMessage({ embeds: [{ title: 'Trivia run', description: `Run failed: ${text}`, color: 0xe74c3c }] });
    } catch (e) {
        try { log(`Discord: failure post failed: ${e?.message ?? e}`); } catch { /* ignore */ }
    }
}
