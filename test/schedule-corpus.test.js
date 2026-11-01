// Every saved r/420Grindhouse schedule post (test/fixtures/schedule-corpus, refreshed with
// scripts/fetch-schedule-corpus.js) must parse cleanly: a date range, all three days, and
// every listed film captured with a year. A future format change that drops films fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDateRange, parseSchedule, flattenMovies } from '../src/schedule.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'schedule-corpus');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
// Listed without a year in the post itself -- nothing to recover.
const KNOWN_YEARLESS = new Set(['Bloodstone: Subspecies II']);

test('corpus is present', () => assert.ok(files.length >= 50, `only ${files.length} fixtures`));

for (const f of files) {
    test(`corpus ${f}`, () => {
        const post = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        assert.ok(parseDateRange(post.title, post.publishedAt), `no date range in "${post.title}"`);
        const days = parseSchedule(post.contentHtml);
        assert.deepEqual(days.map(d => d.day), ['Friday', 'Saturday', 'Sunday']);
        // Recall: every non-empty <li> in the post is a parsed item.
        const liCount = [...post.contentHtml.matchAll(/<li>([\s\S]*?)<\/li>/g)].filter(m => m[1].replace(/<[^>]+>/g, '').trim()).length;
        const items = days.flatMap(d => d.sections.flatMap(s => s.items));
        assert.equal(items.length, liCount, 'some list items were not captured');
        for (const m of flattenMovies(days)) {
            if (!KNOWN_YEARLESS.has(m.title)) assert.ok(m.year, `no year for "${m.title}"`);
            assert.doesNotMatch(m.title, /&(amp|#\d+|quot|lt|gt);|[()[\]]\s*$/, `junk left in "${m.title}"`);
        }
    });
}
