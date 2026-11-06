// Posts the run summary and one picker per movie needing a human decision. Never throws.
import { buildSummary, buildPicker, needsPicker } from './format.js';

export async function notifyRun({ api, store, results, postTitle = null, log = () => {} }) {
    const warn = (what, e) => { try { log(`Discord: ${what} failed: ${e?.message ?? e}`); } catch { /* ignore */ } };
    try {
        await api.postMessage(buildSummary(results, { postTitle }));
    } catch (e) { warn('summary post', e); }
    try {
        for (const r of results ?? []) {
            try {
                if (!needsPicker(r)) continue;
                const m = r.match;
                const guessed = r.status === 'done' && m.confidence === 'unsure';
                const id = store.add({
                    scheduleTitle: m.scheduleTitle,
                    scheduleYear: m.scheduleYear,
                    candidates: m.candidates,
                    guessTconst: guessed ? r.tconst ?? null : null,
                    guessFile: guessed ? r.dataFile ?? null : null,
                    messageId: null,
                });
                const msg = await api.postMessage(buildPicker(store.get(id)));
                store.update(id, { messageId: msg.id });
            } catch (e) { warn(`picker for "${r?.title}"`, e); }
        }
    } catch (e) { warn('pickers', e); }
}
