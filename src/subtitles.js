import fs from 'node:fs';
import path from 'node:path';
import { USER_AGENT } from './http.js';

// Optional source: English subtitles from OpenSubtitles (REST API v1), turned into a timestamped
// dialogue transcript so the model can pin facts to the moment they happen on screen.
// Needs OPENSUBTITLES_API_KEY (free consumer key); OPENSUBTITLES_USERNAME/PASSWORD raise the
// daily download quota (anonymous: 5/day per IP; free account: 10-20/day). Without a key this is a no-op.
// Downloaded .srt files are cached in cacheDir (re-runs with --force don't spend quota), pruned after
// CACHE_DAYS so the volume doesn't grow.
const API = 'https://api.opensubtitles.com/api/v1';
const MAX_TRANSCRIPT = 60000;   // chars handed to the model (~90 min of dialogue)
export const CACHE_DAYS = 60;

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

export function pruneCache(cacheDir, nowMs = Date.now(), maxDays = CACHE_DAYS) {
    let names;
    try { names = fs.readdirSync(cacheDir); } catch { return; }
    for (const n of names) {
        const p = path.join(cacheDir, n);
        try { if (nowMs - fs.statSync(p).mtimeMs > maxDays * 86400000) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    }
}

const transcriptFrom = (srt, extra) => {
    const cues = parseSrt(srt);
    if (cues.length < 20) return null;
    return { text: transcriptText(cues), cues: cues.length, lastCueSec: Math.round(cues[cues.length - 1].start), ...extra };
};

export function makeSubtitles({ apiKey, username, password, cacheDir = null } = {}, fetchImpl = fetch) {
    if (!apiKey) return { fetchTranscript: async () => null, isExhausted: () => false };
    if (cacheDir) pruneCache(cacheDir);
    let base = API, token = null, loggedIn = false;
    let exhausted = false;   // daily download quota used up: stop asking for the rest of this run
    const headers = extra => ({ 'Api-Key': apiKey, 'User-Agent': USER_AGENT, Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra });
    async function call(endpoint, opts = {}) {
        const r = await fetchImpl(`${base}${endpoint}`, { ...opts, headers: headers(opts.headers), signal: AbortSignal.timeout(20000) });
        if (endpoint === '/download' && (r.status === 406 || r.status === 429)) { exhausted = true; return null; }
        if (!r.ok) throw new Error(`OpenSubtitles HTTP ${r.status} for ${endpoint.split('?')[0]}`);
        return r.json();
    }
    async function login() {
        if (loggedIn || !username || !password) return;
        loggedIn = true;
        const j = await call('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        token = j.token || null;
        if (j.base_url) base = `https://${j.base_url.replace(/^https?:\/\//, '')}/api/v1`;
    }

    // -> { text, cues, lastCueSec, release, fileId, cached } | null
    async function fetchTranscript(tconst) {
        const imdbNum = Number(String(tconst).replace(/^tt/, ''));
        if (!imdbNum) return null;
        const cacheFile = cacheDir ? path.join(cacheDir, `tt${imdbNum}.srt`) : null;
        if (cacheFile && fs.existsSync(cacheFile)) return transcriptFrom(fs.readFileSync(cacheFile, 'utf8'), { cached: true });
        if (exhausted) return null;
        await login();
        const found = await call(`/subtitles?imdb_id=${imdbNum}&languages=en&order_by=download_count`);
        const best = pickSubtitle(found.data);
        if (!best) return null;
        const dl = await call('/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: best.files[0].file_id }) });
        if (!dl?.link) return null;
        if (typeof dl.remaining === 'number' && dl.remaining <= 0) exhausted = true;
        const res = await fetchImpl(dl.link, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`OpenSubtitles file HTTP ${res.status}`);
        const srt = await res.text();
        if (cacheFile) { try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, srt); } catch { /* cache is optional */ } }
        return transcriptFrom(srt, { release: best.release || null, fileId: best.files[0].file_id, cached: false });
    }
    return { fetchTranscript, isExhausted: () => exhausted };
}
