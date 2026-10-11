import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTotals, parseTotalsCard, splitSentences, leadingNumberToDigits, titleCase } from '../src/driveintotals.js';

const CARNIVAL = 'No breasts (1962). Nineteen dead bodies. Approximately 15 zombies. One motor vehicle chase, with watery crash. '
    + 'Zombie bus tour. Church organ Fu. Zombie Fu. Drive-In Academy Award nominations for Candace Hilligoss, for saying '
    + '"I don\'t belong in the world"; and Herk Harvey, for producing, directing, and playing the Head Zombie. '
    + 'In the Drive-In Hall of Fame. Four stars. Joe Bob says check it out.';

test('parseTotalsCard: Carnival of Souls -> MonsterVision lines, 4 stars, awards kept for Claude', () => {
    const c = parseTotalsCard(CARNIVAL);
    assert.deepEqual(c.lines, ['No Breasts (1962)', '19 Dead Bodies', 'About 15 Zombies', '1 Motor Vehicle Chase, with Watery Crash',
        'Zombie Bus Tour', 'Church Organ Fu', 'Zombie Fu']);
    assert.equal(c.stars, 4);
    assert.equal(c.says, 'Joe Bob says check it out.');
    assert.match(c.awards, /^Drive-In Academy Award nominations for Candace Hilligoss/);
    assert.match(c.awards, /In the Drive-In Hall of Fame\.$/);
});
test('parseTotalsCard: "We\'ve Got" / "We Have A Total Of" lead-ins, half stars', () => {
    const sea = parseTotalsCard("We've Got Fifteen Complete Kung Fu Fight Scenes, Including Everything From One-On-One to Four-On-One to Eight-On-One. "
        + 'We Got Three Complete Kung Fu Comedy Scenes. No Beasts. Five Corpses. Three and a half stars. Joe Bob says check it out.');
    assert.deepEqual(sea.lines, ['15 Complete Kung Fu Fight Scenes, Including Everything from One-On-One to Four-On-One to Eight-On-One',
        '3 Complete Kung Fu Comedy Scenes', 'No Beasts', '5 Corpses']);
    assert.equal(sea.stars, 3.5);
    const torture = parseTotalsCard('We Have A Total Of Seventy-Six Breasts. Heads Roll (four times). Three and a half stars. Joe Bob says check it out.');
    assert.deepEqual(torture.lines, ['76 Breasts', 'Heads Roll (Four Times)']);
});
test('parseTotalsCard: one long comma list with the rating inline', () => {
    const c = parseTotalsCard('We have 103 dead bodies, one dead Neanderthal, two partial breasts, sword fighting, skeleton food, three stars.');
    assert.deepEqual(c.lines, ['103 Dead Bodies', '1 Dead Neanderthal', '2 Partial Breasts', 'Sword Fighting', 'Skeleton Food']);
    assert.equal(c.stars, 3);
    assert.equal(c.says, '');
});
test('parseTotalsCard: "Drive-Im" typo still starts the awards', () => {
    const c = parseTotalsCard('Five dead bodies. Forhorn fu. Drive-Im academy nominations for: John Karlen. Danielle Ouimet. Four stars. Joe Bob says check it out.');
    assert.deepEqual(c.lines, ['5 Dead Bodies', 'Forhorn Fu']);
    assert.equal(c.awards, 'Drive-Im academy nominations for: John Karlen. Danielle Ouimet.');
});
test('parseTotalsCard: sign-off kept as written, bare "Check it out." normalized', () => {
    assert.equal(parseTotalsCard('Ten dead bodies. Four stars. Outstanding. Joe Bob says check it out.').says, 'Outstanding. Joe Bob says check it out.');
    assert.equal(parseTotalsCard('Two dead bodies. Two stars. Check it out.').says, 'Joe Bob says check it out.');
});
test('parseTotalsCard: quotes and cast call-outs go to awards, not the card', () => {
    const c = parseTotalsCard('Twelve dead bodies. With Bryan Madorsky as the kid who boils a cat. '
        + 'Tripp has the best line: "We accidentally summoned these demons." Two stars.');
    assert.deepEqual(c.lines, ['12 Dead Bodies']);
    assert.match(c.awards, /Bryan Madorsky/);
    assert.match(c.awards, /best line/);
});
test('parseTotalsCard: no verdict / empty input', () => {
    assert.deepEqual(parseTotalsCard('Two dead bodies. Kung fu.'), { lines: ['2 Dead Bodies', 'Kung Fu'], stars: null, says: '', awards: '' });
    assert.deepEqual(parseTotalsCard(''), { lines: [], stars: null, says: '', awards: '' });
});
test('splitSentences ignores periods in quotes, parentheses, abbreviations', () => {
    assert.deepEqual(splitSentences('Mr. T fights. Heads roll (twice. maybe). He said "Stop. Now." Done.'),
        ['Mr. T fights.', 'Heads roll (twice. maybe).', 'He said "Stop. Now."', 'Done.']);
});
test('leadingNumberToDigits converts only the leading number phrase', () => {
    assert.equal(leadingNumberToDigits('Seventy-Six breasts'), '76 breasts');
    assert.equal(leadingNumberToDigits('Twenty dead bodies'), '20 dead bodies');
    assert.equal(leadingNumberToDigits('One hundred and twelve corpses'), '112 corpses');
    assert.equal(leadingNumberToDigits('Including One With a brush'), 'Including One With a brush');
    assert.equal(leadingNumberToDigits('Oneida Fu'), 'Oneida Fu');
});
test('titleCase keeps small words low mid-line and never lowercases', () => {
    assert.equal(titleCase('blood slurpin (with explosions) n burn'), 'Blood Slurpin (With Explosions) n Burn');
    assert.equal(titleCase('TV repairman of the year'), 'TV Repairman of the Year');
});
test('parseTotalsCard: every real Totals row', () => {
    const rows = parseTotals(fs.readFileSync(new URL('./fixtures/drivein_totals.csv', import.meta.url), 'utf8'));
    assert.ok(rows.length > 300);
    const noCard = [];
    for (const r of rows) {
        const c = parseTotalsCard(r.description);
        assert.ok(c.lines.every(l => l.trim()), `${r.title}: empty line`);
        if (/\bstars?\b/i.test(r.description)) assert.notEqual(c.stars, null, `${r.title}: rating not parsed`);
        if (!c.lines.length) noCard.push(r.title);
    }
    assert.ok(noCard.length <= 2, `rows without a card: ${noCard.join(', ')}`);
});
