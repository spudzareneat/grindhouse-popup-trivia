import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('parseArgs: unknown -- option is an error', () => {
    assert.match(parseArgs(['run', '--dryrun']).error, /unknown option: --dryrun/);
});
test('parseArgs: --year must be followed by a 4-digit number', () => {
    assert.match(parseArgs(['movie', 'X', '--year']).error, /--year/);
    assert.match(parseArgs(['movie', 'X', '--year', '80']).error, /--year/);
    assert.match(parseArgs(['movie', 'X', '--year', '--dry-run']).error, /--year/);
});
test('parseArgs: valid movie args', () => {
    const a = parseArgs(['movie', 'X', '--year', '1980', '--dry-run']);
    assert.equal(a.error, undefined);
    assert.deepEqual(a._, ['movie', 'X']);
    assert.equal(a.year, 1980);
    assert.equal(a.dryRun, true);
    assert.equal(a.force, false);
});
