import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSrt, transcriptText, pickSubtitle, makeSubtitles, fmtTime, pruneCache } from '../src/subtitles.js';
import { usableTranscript, processMovie } from '../src/pipeline.js';
import { jsonResponse, textResponse } from './helpers.js';

const SRT = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nSubtitles by OpenSubtitles.org\r\n\r\n'
    + '2\n00:01:05,500 --> 00:01:07,000\n<i>They\'re coming</i>\nto get you, Barbara!\n\n'
    + '3\n00:01:07,200 --> 00:01:08,000\n- Stop it!\n\n'
    + '4\n01:02:03,000 --> 01:02:04,000\n{\an8}The end.\n';

test('parseSrt: times, tags, ads dropped, BOM/CRLF tolerated', () => {
    assert.deepEqual(parseSrt(SRT), [
        { start: 65.5, text: "They're coming to get you, Barbara!" },
        { start: 67.2, text: '- Stop it!' },
        { start: 3723, text: 'The end.' },
    ]);
});
test('transcriptText merges cues under 3 s apart and respects the char budget', () => {
    assert.equal(transcriptText(parseSrt(SRT)), "[1:05] They're coming to get you, Barbara! - Stop it!\n[62:03] The end.");
    assert.equal(transcriptText(parseSrt(SRT), 50), '');
    assert.equal(fmtTime(3723), '62:03');
});
test('pickSubtitle: no machine/AI translations, prefers non-HI, then downloads', () => {
    const r = (id, a) => ({ attributes: { files: [{ file_id: id }], download_count: 0, ...a } });
    assert.equal(pickSubtitle([r(1, { download_count: 900, hearing_impaired: true }), r(2, { download_count: 5 }), r(3, { download_count: 9999, ai_translated: true })]).files[0].file_id, 2);
    assert.equal(pickSubtitle([]), null);
});
test('makeSubtitles: no key -> no-op; with key logs in, searches by imdb number, downloads', async () => {
    assert.equal(await makeSubtitles({}).fetchTranscript('tt0068622'), null);
    const calls = [];
    const many = Array.from({ length: 25 }, (_, i) => `${i + 1}\n00:${String(10 + i).padStart(2, '0')}:00,000 --> 00:${String(10 + i).padStart(2, '0')}:01,000\nLine ${i}\n`).join('\n');
    const fetchImpl = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', auth: opts.headers?.Authorization, key: opts.headers?.['Api-Key'] });
        if (url.endsWith('/login')) return jsonResponse({ token: 'T', base_url: 'vip-api.opensubtitles.com' });
        if (url.includes('/subtitles?')) return jsonResponse({ data: [{ attributes: { release: 'Gargoyles.1972.DVDRip', download_count: 3, files: [{ file_id: 42 }] } }] });
        if (url.endsWith('/download')) return jsonResponse({ link: 'https://dl.example/42.srt' });
        return textResponse(many);
    };
    const t = await makeSubtitles({ apiKey: 'K', username: 'u', password: 'p' }, fetchImpl).fetchTranscript('tt0068622');
    assert.equal(calls[0].url, 'https://api.opensubtitles.com/api/v1/login');
    assert.match(calls[1].url, /^https:\/\/vip-api\.opensubtitles\.com\/api\/v1\/subtitles\?imdb_id=68622&languages=en/);
    assert.equal(calls[1].auth, 'Bearer T');
    assert.equal(calls[1].key, 'K');
    assert.equal(calls[2].method, 'POST');
    assert.equal(t.cues, 25);
    assert.equal(t.lastCueSec, 34 * 60);
    assert.equal(t.release, 'Gargoyles.1972.DVDRip');
    assert.match(t.text, /^\[10:00\] Line 0\n\[11:00\] Line 1/);
});
test('usableTranscript drops subtitles from a different cut', () => {
    const s = { text: 'x', lastCueSec: 4400 };
    assert.equal(usableTranscript(s, 4440), s);
    assert.equal(usableTranscript(s, 3000), null);                      // dialogue runs past the end
    assert.equal(usableTranscript({ ...s, lastCueSec: 2000 }, 4440), null); // stops far too early
    assert.equal(usableTranscript(s, null), s);
    assert.equal(usableTranscript(null, 4440), null);
});

const SRT25 = Array.from({ length: 25 }, (_, i) => `${i + 1}\n00:${String(10 + i).padStart(2, '0')}:00,000 --> 00:${String(10 + i).padStart(2, '0')}:01,000\nLine ${i}\n`).join('\n');
function osStub({ remaining = 10, downloadStatus = 200 } = {}) {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        calls.push(url);
        if (url.includes('/subtitles?')) return jsonResponse({ data: [{ attributes: { download_count: 1, files: [{ file_id: 7 }] } }] });
        if (url.endsWith('/download')) return downloadStatus === 200 ? jsonResponse({ link: 'https://dl.example/7.srt', remaining }) : jsonResponse({ message: 'quota' }, downloadStatus);
        return textResponse(SRT25);
    };
    return { calls, fetchImpl };
}

test('subtitles: quota used up (remaining 0 or HTTP 406) stops further requests this run', async () => {
    const a = osStub({ remaining: 0 });
    const s = makeSubtitles({ apiKey: 'K' }, a.fetchImpl);
    assert.ok(await s.fetchTranscript('tt1'));          // the last allowed download still counts
    assert.equal(s.isExhausted(), true);
    const n = a.calls.length;
    assert.equal(await s.fetchTranscript('tt2'), null);
    assert.equal(a.calls.length, n);                    // no search, no download

    const b = osStub({ downloadStatus: 406 });
    const s2 = makeSubtitles({ apiKey: 'K' }, b.fetchImpl);
    assert.equal(await s2.fetchTranscript('tt1'), null);
    assert.equal(s2.isExhausted(), true);
});
test('subtitles: downloaded file cached; second fetch uses no network; old cache files pruned', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-subs-'));
    const a = osStub();
    const s = makeSubtitles({ apiKey: 'K', cacheDir: dir }, a.fetchImpl);
    assert.equal((await s.fetchTranscript('tt0068622')).cached, false);
    assert.ok(fs.existsSync(path.join(dir, 'tt68622.srt')));
    const n = a.calls.length;
    const again = await s.fetchTranscript('tt0068622');
    assert.equal(again.cached, true);
    assert.equal(again.cues, 25);
    assert.equal(a.calls.length, n);

    const old = path.join(dir, 'tt1.srt');
    fs.writeFileSync(old, 'x');
    const longAgo = new Date(Date.now() - 90 * 86400000);
    fs.utimesSync(old, longAgo, longAgo);
    pruneCache(dir);
    assert.equal(fs.existsSync(old), false);
    assert.ok(fs.existsSync(path.join(dir, 'tt68622.srt')));
    fs.rmSync(dir, { recursive: true, force: true });
});
test('processMovie: subtitles only for the first two blocks of a night', async () => {
    const asked = [];
    const subtitles = { fetchTranscript: async t => { asked.push(t); return null; }, isExhausted: () => false };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-blocks-'));
    const f = (t, text) => ({ t, rank: 1, anchor: 'spread', text, icon: 'reel', source: { type: 'web', url: 'https://x/' + text } });
    const many = Array.from({ length: 40 }, (_, i) => f(100 + i * 100, `f${i}`));
    const deps = {
        imdb: { searchTitle: async t => ({ tconst: `tt${t.length}` }), fetchBundle: async tconst => ({ tconst, title: 'X', year: 1980, runtimeSec: 4680, people: [] }) },
        wiki: { fetchWikidata: async () => null, fetchRelatedArticles: async () => [] }, tmdb: { fetchExtras: async () => null }, subtitles, totalsRows: [],
        runClaude: async () => ({ ok: true, usageLimited: false, facts: many }), model: 'sonnet',
        dataDir: path.join(root, 'data'), outDir: path.join(root, 'out'), git: { commitAndPush() {} }, force: true, dryRun: true, log: () => {}, now: () => 'now',
    };
    await processMovie({ title: 'a', year: 1980, block: 0 }, deps);
    await processMovie({ title: 'bb', year: 1980, block: 1 }, deps);
    await processMovie({ title: 'ccc', year: 1980, block: 2 }, deps);
    await processMovie({ title: 'dddd', year: 1980 }, deps);              // `movie` command: no block -> always
    assert.deepEqual(asked, ['tt1', 'tt2', 'tt4']);
    fs.rmSync(root, { recursive: true, force: true });
});
