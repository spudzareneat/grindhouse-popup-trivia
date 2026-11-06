import fs from 'node:fs';
import path from 'node:path';
import { normalizeTitle } from './titles.js';

export function overrideKey(title, year) {
  return `${normalizeTitle(title)}|${year ?? ''}`;
}

export function loadOverrides(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      picks: data && typeof data.picks === 'object' && data.picks ? data.picks : {},
      dismissed: data && typeof data.dismissed === 'object' && data.dismissed ? data.dismissed : {},
    };
  } catch {
    return { picks: {}, dismissed: {} };
  }
}

export function saveOverride(file, key, entry) {
  const o = loadOverrides(file);
  if (entry.dismissed) {
    o.dismissed[key] = true;
    delete o.picks[key];
  } else {
    o.picks[key] = entry.tconst;
    delete o.dismissed[key];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(o, null, 2) + '\n');
}
