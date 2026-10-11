import fs from 'node:fs';
import path from 'node:path';
import { findTotals, parseTotalsCard } from './driveintotals.js';
import { DRIVEIN_T, END_MARGIN } from './schema.js';
import { spaceFacts, driveInWindow } from './validate.js';
import { writeDoc } from './publish.js';

const OLD_TOTALS = /^drive-in totals\b/i;   // "Drive-In Totals:", "Drive-In Totals verdict:", ...
const AWARDISH = /academy|hall of fame|nominat/i;

// Moves an already-published doc to the Drive-In Totals card: drops the old count/verdict bubbles (award
// nominations stay), adds driveIn and clears the card's window. Facts aren't re-validated, so headshots stay.
// null = the Totals don't make a card.
export function backfillDoc(doc, totals) {
    const card = parseTotalsCard(totals);
    if (!card.lines.length) return null;
    const driveIn = { t: DRIVEIN_T, lines: card.lines, stars: card.stars, says: card.says };
    const keep = doc.facts.filter(f => !OLD_TOTALS.test(f.text) || AWARDISH.test(f.text)).map(f => ({ ...f }));
    const maxT = doc.runtimeSec ? doc.runtimeSec - END_MARGIN : Infinity;
    const { facts } = spaceFacts(keep, maxT, driveInWindow(driveIn));
    return { doc: { ...doc, facts, driveIn }, removed: doc.facts.length - keep.length };
}

// Every data/*.json with Totals and no card yet (or all of them with force); one commit per file.
export function runBackfill({ dataDir, outDir, totalsRows, git, dryRun, force, log }) {
    const results = [];
    for (const name of fs.readdirSync(dataDir).filter(n => n.endsWith('.json')).sort()) {
        const doc = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
        if (doc.driveIn && !force) continue;
        const totals = findTotals(totalsRows, doc.title, doc.year);
        if (!totals) continue;
        const r = backfillDoc(doc, totals);
        if (!r) { log(`  ${doc.title} (${doc.year}): Totals don't make a card — left as is`); continue; }
        if (JSON.stringify(r.doc) === JSON.stringify(doc)) continue;   // --force re-run: nothing changed, nothing to commit
        const file = writeDoc(dryRun ? outDir : dataDir, r.doc);
        log(`  ${doc.title} (${doc.year}): card with ${r.doc.driveIn.lines.length} lines, ${r.doc.driveIn.stars ?? 'no'} stars; removed ${r.removed} old Totals bubbles`);
        if (!dryRun) git.commitAndPush(file, `data: ${doc.title} (${doc.year}) — Drive-In Totals card\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
        results.push({ imdbId: doc.imdbId, removed: r.removed, lines: r.doc.driveIn.lines.length });
    }
    return results;
}
