// The data contract shared with the userscript's trivia-popup module
// (docs/curated-popup-trivia-design.md section 1). ICON_KEYS is pinned in the
// userscript's scripts/test-trivia-icons.mjs too -- only ever ADD keys, at the end.

export const SCHEMA_VERSION = 1;

export const ICON_KEYS = [
    'skull', 'tombstone', 'reel', 'saucer', 'alien', 'rocket', 'robot', 'radioactive',
    'explosion', 'crosshair', 'knuckles', 'disco', 'boombox', 'sunglasses',
    'joebob', 'money', 'camera', 'star', 'link', 'mic', 'censor', 'trophy',
];

export const SOURCE_TYPES = ['imdb', 'driveintotals', 'wikipedia', 'wikidata', 'tmdb', 'transcript', 'web', 'interview'];
export const URL_REQUIRED = new Set(['web', 'interview']);

export const MAX_TEXT = 200;   // chars
export const MIN_T = 60;       // no fact in the first minute
export const MIN_GAP = 45;     // seconds between consecutive facts
export const END_MARGIN = 30;  // latest fact = runtime - END_MARGIN
export const MIN_FACTS = 5;    // fewer than this after a retry = movie fails

// Passed to `claude -p --json-schema`. Kept to plain JSON Schema (type/enum/required)
// -- validateFacts() is the real gate, this just steers the model's output shape.
export const MODEL_OUTPUT_SCHEMA = {
    type: 'object',
    required: ['facts'],
    properties: {
        facts: {
            type: 'array',
            items: {
                type: 'object',
                required: ['t', 'rank', 'anchor', 'text', 'icon', 'source'],
                properties: {
                    t: { type: 'integer' },
                    rank: { type: 'integer', enum: [1, 2, 3] },
                    anchor: { type: 'string', enum: ['scene', 'spread'] },
                    text: { type: 'string' },
                    icon: { type: 'string', enum: ICON_KEYS },
                    byline: { type: 'string' },
                    source: {
                        type: 'object',
                        required: ['type'],
                        properties: {
                            type: { type: 'string', enum: SOURCE_TYPES },
                            url: { type: 'string' },
                        },
                    },
                },
            },
        },
    },
};
