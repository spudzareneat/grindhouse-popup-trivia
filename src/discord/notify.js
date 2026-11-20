// Posts the run summary and one picker per movie needing a human decision. Never throws.
import fs from 'node:fs';
import path from 'node:path';
import { buildSummary, buildPicker, needsPicker } from './format.js';
import { overrideKey } from '../overrides.js';
import { RELOGIN_STEPS } from '../reddit-browser.js';

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
        const hint = error?.hint ? `

${String(error.hint).slice(0, 1500)}` : '';
        await api.postMessage({ embeds: [{ title: 'Trivia run', description: `Run failed: ${text}${hint}`, color: 0xe74c3c }] });
    } catch (e) {
        try { log(`Discord: failure post failed: ${e?.message ?? e}`); } catch { /* ignore */ }
    }
}

// The schedule scrape needs a logged-in Reddit session that eventually expires. Starting thresholdDays before that,
// post a reminder with the renewal steps, at most once per calendar day (markerFile holds the last day posted).
// Returns true if a message was posted. Never throws.
export async function notifySessionExpiring({ api, expiresAt, now = Date.now(), thresholdDays = 30, markerFile = null, log = () => {} }) {
    try {
        if (!expiresAt) return false;
        const daysLeft = Math.floor((expiresAt * 1000 - now) / 86400000);
        if (daysLeft > thresholdDays) return false;
        const today = new Date(now).toISOString().slice(0, 10);
        if (markerFile) { try { if (fs.readFileSync(markerFile, 'utf8').trim() === today) return false; } catch { /* no marker yet */ } }
        const date = new Date(expiresAt * 1000).toISOString().slice(0, 10);
        const when = daysLeft < 0 ? `has expired (${date})` : `expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${date})`;
        await api.postMessage({ embeds: [{
            title: 'Reddit login needs renewing',
            description: `The Reddit session the schedule scrape uses ${when}. When it does, weekend runs fail until it is renewed.

${RELOGIN_STEPS}`,
            color: 0xf39c12,
        }] });
        if (markerFile) { fs.mkdirSync(path.dirname(markerFile), { recursive: true }); fs.writeFileSync(markerFile, today); }
        return true;
    } catch (e) {
        try { log(`Discord: session expiry warning failed: ${e?.message ?? e}`); } catch { /* ignore */ }
        return false;
    }
}
