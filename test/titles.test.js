import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, titlesMatch, titleVariants, titleSimilarity } from '../src/titles.js';

test('normalizeTitle strips leading article, punctuation, roman numerals', () => {
    assert.equal(normalizeTitle('The Evil Dead II: Dead by Dawn'), 'evil dead 2 dead by dawn');
});
test('titlesMatch tolerates punctuation and subtitles', () => {
    assert.equal(titlesMatch('Alligator', 'Alligator'), true);
    assert.equal(titlesMatch("Don't Look in the Basement", 'Dont Look in the Basement'), true);
});
test('titlesMatch rejects titles sharing only connector words', () => {
    assert.equal(titlesMatch('Island of the Living Dead', 'Night of the Living Dead'), false);
    assert.equal(titlesMatch('Alligator', 'The Alligator People'), false);
});
test('titlesMatch empty -> false', () => {
    assert.equal(titlesMatch('', 'x'), false);
});
test('titlesMatch strips curly apostrophes', () => {
    assert.equal(titlesMatch('Don’t Look in the Basement', 'Dont Look in the Basement'), true);
});

test('titleVariants: event-label prefixes, subtitle tags, nothing for plain titles', () => {
    assert.deepEqual(titleVariants('Basement Grindhouse - HauntedWeen'), ['HauntedWeen', 'Basement Grindhouse']);
    assert.deepEqual(titleVariants('Monstervision – The Howling III: The Marsupials').slice(0, 1), ['The Howling III: The Marsupials']);
    assert.ok(titleVariants('Monstervision - Friday the 13th Part 4: The Final Chapter').includes('Friday the 13th Part 4'));
    assert.deepEqual(titleVariants('WAR: Women Against Rape'), ['Women Against Rape', 'WAR']);
    assert.deepEqual(titleVariants('Carnival of Souls'), []);
    assert.deepEqual(titleVariants('Psycho-Circus'), []);   // unspaced hyphen is part of the title
});

test('titleSimilarity scores in [0, 1]', () => {
    assert.equal(titleSimilarity('Alligator', 'Alligator'), 1);
    assert.equal(titleSimilarity('The Fly', 'Fly'), 1);
    assert.equal(titleSimilarity('', 'x'), 0);
    assert.ok(titleSimilarity('Alligator', 'Alligator II: The Mutation') < 0.7);
});
test('titlesMatch agrees with titleSimilarity >= 0.7', () => {
    const pairs = [
        ['Alligator', 'Alligator'],
        ['Alligator', 'The Alligator People'],
        ['Island of the Living Dead', 'Night of the Living Dead'],
        ["Don't Look in the Basement", 'Dont Look in the Basement'],
        ['', 'x'],
    ];
    for (const [a, b] of pairs) assert.equal(titlesMatch(a, b), titleSimilarity(a, b) >= 0.7);
});
