import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfillDoc, runBackfill } from '../src/backfill.js';
import { writeDoc } from '../src/publish.js';

const f = (t, text) => ({ t, rank: 2, anchor: 'spread', text, icon: 'joebob', byline: 'Joe Bob Briggs', source: { type: 'driveintotals' } });
const TOTALS = 'Nineteen dead bodies. Zombie Fu. Drive-In Academy Award nominations for Candace Hilligoss. Four stars. Joe Bob says check it out.';
const DOC = {
    schema: 1, imdbId: 'tt0055830', title: 'Carnival of Souls', year: 1962, runtimeSec: 4680, generatedAt: 'x',
    facts: [
        f(300, 'Drive-In Totals: No breasts (1962). Nineteen dead bodies.'),
        f(900, 'Drive-In Totals: Drive-In Academy Award nominations for Candace Hilligoss.'),
        { ...f(1200, 'Herk Harvey made industrial films.'), icon: 'reel', person: 'nm0367547', image: 'https://m.media-amazon.com/images/M/x.jpg' },
        f(4500, 'Drive-In Totals: Four stars. Joe Bob says check it out.'),
    ],
};

function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-bf-'));
    const dataDir = path.join(root, 'data');
    writeDoc(dataDir, DOC);
    writeDoc(dataDir, { ...DOC, imdbId: 'tt1', title: 'No Totals Movie', year: 1999 });
    const commits = [];
    const deps = {
        dataDir, outDir: path.join(root, 'out'),
        totalsRows: [{ title: 'Carnival of Souls', year: 1962, description: TOTALS }],
        git: { commitAndPush: (p, m) => commits.push({ p, m }) },
        dryRun: false, force: false, log: () => {},
    };
    return { deps, commits, dataDir };
}

test('backfillDoc: drops count/verdict bubbles, keeps awards and other facts untouched, adds driveIn', () => {
    const r = backfillDoc(DOC, TOTALS);
    assert.equal(r.removed, 2);
    assert.deepEqual(r.doc.facts.map(x => x.t), [900, 1200]);
    assert.equal(r.doc.facts[1].person, 'nm0367547');           // headshot fields survive (no re-validation)
    assert.deepEqual(r.doc.driveIn, { t: 15, lines: ['19 Dead Bodies', 'Zombie Fu'], stars: 4, says: 'Joe Bob says check it out.' });
    assert.deepEqual(Object.keys(r.doc).slice(-2), ['facts', 'driveIn']);
    assert.equal(DOC.facts.length, 4);                            // input not mutated
    assert.equal(DOC.facts[0].t, 300);
});
test('backfillDoc: Totals that make no card -> null', () => {
    assert.equal(backfillDoc(DOC, ''), null);
});
test('runBackfill: updates + commits matching files once; a second run is a no-op', () => {
    const { deps, commits, dataDir } = setup();
    assert.equal(runBackfill(deps).length, 1);
    assert.equal(commits.length, 1);
    assert.match(commits[0].m, /Carnival of Souls \(1962\) — Drive-In Totals card/);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'tt0055830.json'), 'utf8'));
    assert.equal(saved.driveIn.lines.length, 2);
    assert.equal(runBackfill(deps).length, 0);
    assert.equal(commits.length, 1);
});
test('runBackfill --dry-run writes to out/ and commits nothing', () => {
    const { deps, commits, dataDir } = setup();
    assert.equal(runBackfill({ ...deps, dryRun: true }).length, 1);
    assert.equal(commits.length, 0);
    assert.equal('driveIn' in JSON.parse(fs.readFileSync(path.join(dataDir, 'tt0055830.json'), 'utf8')), false);
    assert.ok(fs.existsSync(path.join(deps.outDir, 'tt0055830.json')));
});
test('runBackfill --force skips files that would not change (no empty commit)', () => {
    const { deps, commits } = setup();
    runBackfill(deps);
    const git = { commitAndPush: (p, m) => { if (commits.some(c => c.p === p)) throw new Error('nothing to commit'); commits.push({ p, m }); } };
    assert.equal(runBackfill({ ...deps, force: true, git }).length, 0);
    assert.equal(commits.length, 1);
});
