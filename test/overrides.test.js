import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { overrideKey, loadOverrides, saveOverride } from '../src/overrides.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-')), 'sub', 'title-overrides.json');

test('overrideKey is stable across case, leading The and punctuation, but differs by year', () => {
  assert.equal(overrideKey('The Fly!', 1958), overrideKey('fly', 1958));
  assert.notEqual(overrideKey('The Fly', 1958), overrideKey('The Fly', 1986));
  assert.ok(overrideKey('Fly', null).endsWith('|'));
});

test('saveOverride then loadOverrides round-trips a pick and a dismissal', () => {
  const f = tmpFile();
  saveOverride(f, 'a|1990', { tconst: 'tt1' });
  saveOverride(f, 'b|', { dismissed: true });
  const o = loadOverrides(f);
  assert.deepEqual(o.picks, { 'a|1990': 'tt1' });
  assert.deepEqual(o.dismissed, { 'b|': true });
  assert.ok(fs.readFileSync(f, 'utf8').endsWith('\n'));
});

test('missing or corrupt file loads as empty', () => {
  const f = tmpFile();
  assert.deepEqual(loadOverrides(f), { picks: {}, dismissed: {} });
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{nope');
  assert.deepEqual(loadOverrides(f), { picks: {}, dismissed: {} });
});
