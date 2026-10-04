import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt, transcriptText, pickSubtitle, makeSubtitles, fmtTime } from '../src/subtitles.js';
import { usableTranscript } from '../src/pipeline.js';
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
