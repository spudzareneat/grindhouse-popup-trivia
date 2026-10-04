import { USER_AGENT } from './http.js';

// Optional source: English subtitles from OpenSubtitles (REST API v1), turned into a timestamped
// dialogue transcript so the model can pin facts to the moment they happen on screen.
// Needs OPENSUBTITLES_API_KEY (free consumer key); OPENSUBTITLES_USERNAME/PASSWORD raise the
// daily download quota. Without a key this is a no-op.
const API = 'https://api.opensubtitles.com/api/v1';
const MAX_TRANSCRIPT = 60000;   // chars handed to the model (~90 min of dialogue)

const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
export const fmtTime = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// SRT -> [{ start, text }], tags / speaker dashes / sound-effect brackets cleaned up.
export function parseSrt(srt) {
    const cues = [];
    for (const block of String(srt).replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/)) {
        const m = block.match(/(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->/);
        if (!m) continue;
        const text = block.slice(block.indexOf('\n', m.index) + 1)
            .replace(/<[^>]+>|\{[^}]*\}/g, '')
            .split('\n').map(l => l.trim()).filter(Boolean).join(' ')
            .replace(/\s+/g, ' ').trim();
        if (!text || /opensubtitles|subtitles by|synced|corrected by/i.test(text)) continue;
        cues.push({ start: toSec(m[1], m[2], m[3], m[4]), text });
    }
    return cues.sort((a, b) => a.start - b.start);
}

// One "[m:ss] line" per cue; cues within 3 s of each other share a line.
export function transcriptText(cues, maxChars = MAX_TRANSCRIPT) {
    const lines = [];
    let cur = null;
    for (const c of cues) {
        if (cur && c.start - cur.last < 3) { cur.text += ` ${c.text}`; cur.last = c.start; continue; }
        cur = { start: c.start, last: c.start, text: c.text };
        lines.push(cur);
    }
    let out = '';
    for (const l of lines) {
        const line = `[${fmtTime(l.start)}] ${l.text}\n`;
        if (out.length + line.length > maxChars) break;
        out += line;
    }
    return out.trimEnd();
}

// Best candidate: human-made, not hearing-impaired if possible, most downloaded.
export function pickSubtitle(results) {
    const ok = (results || []).map(r => r?.attributes).filter(a => a && a.files?.[0]?.file_id && !a.ai_translated && !a.machine_translated);
    const score = a => (a.hearing_impaired ? 0 : 1) * 1e9 + (a.download_count || 0);
    return ok.sort((a, b) => score(b) - score(a))[0] || null;
}

export function makeSubtitles({ apiKey, username, password } = {}, fetchImpl = fetch) {
    if (!apiKey) return { fetchTranscript: async () => null };
    let base = API, token = null, loggedIn = false;
    const headers = extra => ({ 'Api-Key': apiKey, 'User-Agent': USER_AGENT, Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });
    async function call(path, opts = {}) {
        const r = await fetchImpl(`${base}${path}`, { ...opts, headers: headers(opts.headers), signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(`OpenSubtitles HTTP ${r.status} for ${path.split('?')[0]}`);
        return r.json();
    }
    async function login() {
        if (loggedIn || !username || !password) return;
        loggedIn = true;
        const j = await call('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        token = j.token || null;
        if (j.base_url) base = `https://${j.base_url.replace(/^https?:\/\//, '')}/api/v1`;
    }

    // -> { text, cues, lastCueSec, release, fileId } | null
    async function fetchTranscript(tconst) {
        const imdbNum = Number(String(tconst).replace(/^tt/, ''));
        if (!imdbNum) return null;
        await login();
        const found = await call(`/subtitles?imdb_id=${imdbNum}&languages=en&order_by=download_count`);
        const best = pickSubtitle(found.data);
        if (!best) return null;
        const dl = await call('/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: best.files[0].file_id }) });
        if (!dl.link) return null;
        const res = await fetchImpl(dl.link, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`OpenSubtitles file HTTP ${res.status}`);
        const cues = parseSrt(await res.text());
        if (cues.length < 20) return null;
        return { text: transcriptText(cues), cues: cues.length, lastCueSec: Math.round(cues[cues.length - 1].start), release: best.release || null, fileId: best.files[0].file_id };
    }
    return { fetchTranscript };
}
