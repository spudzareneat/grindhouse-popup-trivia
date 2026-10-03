import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, titlesMatch } from '../src/titles.js';

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
