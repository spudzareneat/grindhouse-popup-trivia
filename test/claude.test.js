import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import { buildPrompt, targetFactCount } from '../src/prompt.js';
import { buildClaudeArgs, parseClaudeResult, runClaude } from '../src/claude.js';

const BUNDLE = { tconst: 'tt0055830', title: 'Carnival of Souls', year: 1962, runtimeSec: 4680, plot: 'P', trivia: ['T1'], goofs: [], quotes: [], connections: ['Referenced in: Night of the Living Dead (1968)'], alternateVersions: [], crazyCredits: [], soundtrack: [], filmingLocations: ['Saltair'], people: [{ name: 'Herk Harvey', role: 'director', character: null, trivia: ['HT'], knownFor: [] }] };

test('targetFactCount scales with runtime, bounded 15..40', () => {
    assert.equal(targetFactCount(4680), 31);
    assert.equal(targetFactCount(1200), 15);
    assert.equal(targetFactCount(20000), 40);
    assert.equal(targetFactCount(null), 30);
});
test('buildPrompt carries the film, runtime, sources, totals, icons and rules', () => {
    const p = buildPrompt({ imdb: BUNDLE, wikidata: { budget: ['33000'] }, wikipedia: 'WIKI TEXT', totals: 'Nineteen dead bodies.', tmdb: null });
    for (const s of ['Carnival of Souls (1962)', 'tt0055830', '4680', 'T1', 'Night of the Living Dead', 'WIKI TEXT', 'Nineteen dead bodies.', 'joebob', 'trophy', '200 characters', 'url']) {
        assert.ok(p.includes(s), `prompt missing: ${s}`);
    }
});
test('buildPrompt without totals says so', () => {
    assert.match(buildPrompt({ imdb: BUNDLE, wikidata: null, wikipedia: null, totals: null, tmdb: null }), /No Drive-In Totals/);
});
test('buildClaudeArgs restricts tools to web only, no MCP, JSON schema output', () => {
    const a = buildClaudeArgs({ model: 'sonnet', schema: { type: 'object' } });
    assert.deepEqual(a.slice(0, 1), ['-p']);
    const val = flag => a[a.indexOf(flag) + 1];
    assert.equal(val('--tools'), 'WebSearch,WebFetch');
    assert.equal(val('--allowedTools'), 'WebSearch,WebFetch');
    assert.equal(val('--output-format'), 'json');
    assert.equal(val('--model'), 'sonnet');
    assert.equal(val('--json-schema'), '{"type":"object"}');
    assert.ok(a.includes('--strict-mcp-config'));
    assert.ok(a.includes('--no-session-persistence'));
});
test('parseClaudeResult: structured_output success', () => {
    const r = parseClaudeResult(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { facts: [{ t: 1 }] }, total_cost_usd: 0.5, num_turns: 7 }));
    assert.deepEqual(r, { ok: true, usageLimited: false, facts: [{ t: 1 }], costUsd: 0.5, numTurns: 7 });
});
test('parseClaudeResult: falls back to JSON in result text', () => {
    assert.equal(parseClaudeResult(JSON.stringify({ subtype: 'success', is_error: false, result: '{"facts":[]}' })).ok, true);
});
test('parseClaudeResult: usage limit detected', () => {
    const r = parseClaudeResult(JSON.stringify({ subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1759550400' }));
    assert.equal(r.ok, false);
    assert.equal(r.usageLimited, true);
    assert.equal(parseClaudeResult('', 'Error: 5-hour limit reached').usageLimited, true);
});
test('parseClaudeResult: garbage / missing facts', () => {
    assert.equal(parseClaudeResult('not json').ok, false);
    assert.equal(parseClaudeResult(JSON.stringify({ subtype: 'success', is_error: false, result: 'hello' })).error, 'no facts in output');
});

function fakeSpawn(stdoutText, { code = 0, stderrText = '' } = {}) {
    const calls = [];
    const impl = (bin, args, opts) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        let input = '';
        child.stdin.on('data', d => { input += d; });
        child.stdin.on('finish', () => {
            calls.push({ bin, args, cwd: opts.cwd, input });
            child.stdout.end(stdoutText); child.stderr.end(stderrText);
            setImmediate(() => child.emit('close', code));
        });
        child.kill = () => {};
        return child;
    };
    return { impl, calls };
}
test('runClaude pipes the prompt on stdin from an empty temp cwd and parses output', async () => {
    const { impl, calls } = fakeSpawn(JSON.stringify({ subtype: 'success', is_error: false, structured_output: { facts: [] } }));
    const r = await runClaude('PROMPT TEXT', { model: 'sonnet', schema: {}, spawnImpl: impl });
    assert.equal(r.ok, true);
    assert.equal(calls[0].bin, 'claude');
    assert.equal(calls[0].input, 'PROMPT TEXT');
    assert.match(calls[0].cwd, /gpt-/);
});

test('parseClaudeResult: plain-text usage limit on stdout', () => {
    assert.equal(parseClaudeResult('Claude AI usage limit reached|1759550400').usageLimited, true);
});
test('runClaude: stdin EPIPE error does not crash', async () => {
    const impl = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        child.stdin.on('finish', () => {});
        child.kill = () => {};
        setImmediate(() => {
            child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
            child.stdout.end(JSON.stringify({ subtype: 'success', is_error: false, structured_output: { facts: [] } }));
            child.stderr.end();
            setImmediate(() => child.emit('close', 1));
        });
        return child;
    };
    const r = await runClaude('P', { model: 'sonnet', schema: {}, spawnImpl: impl });
    assert.equal(r.ok, true);
});
test('runClaude: timeout resolves without close, sends SIGTERM then SIGKILL', async () => {
    const kills = [];
    const impl = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        child.kill = sig => { kills.push(sig); };
        return child;
    };
    const r = await runClaude('P', { model: 'sonnet', schema: {}, spawnImpl: impl, timeoutMs: 20, killGraceMs: 20 });
    assert.equal(r.ok, false);
    assert.match(r.error, /timed out/);
    assert.deepEqual(kills, ['SIGTERM']);
    await new Promise(res => setTimeout(res, 60));
    assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
});
test('runClaude: synchronous spawn throw resolves as spawn failed', async () => {
    const r = await runClaude('P', { model: 'sonnet', schema: {}, spawnImpl: () => { throw new Error('ENOENT'); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /spawn failed/);
});
test('runClaude: temp dir is removed afterwards', async () => {
    let cwd;
    const { impl } = fakeSpawn(JSON.stringify({ subtype: 'success', is_error: false, structured_output: { facts: [] } }));
    await runClaude('P', { model: 'sonnet', schema: {}, spawnImpl: (b, a, o) => { cwd = o.cwd; return impl(b, a, o); } });
    assert.ok(cwd);
    assert.equal(fs.existsSync(cwd), false);
});
