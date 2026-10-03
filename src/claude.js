import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Web tools only: fetched pages are untrusted, so the model gets no file/shell access
// (the container holds a deploy key and the OAuth token in env).
export const CLAUDE_TOOLS = 'WebSearch,WebFetch';
const USAGE_LIMIT_RE = /usage limit|limit reached|rate limit|out of (extra )?usage/i;

export function buildClaudeArgs({ model, schema }) {
    return [
        '-p',
        '--output-format', 'json',
        '--json-schema', JSON.stringify(schema),
        '--model', model,
        '--tools', CLAUDE_TOOLS,
        '--allowedTools', CLAUDE_TOOLS,
        '--strict-mcp-config',
        '--no-session-persistence',
    ];
}

export function parseClaudeResult(stdout, stderr = '') {
    let j;
    try { j = JSON.parse(stdout); } catch {
        return { ok: false, usageLimited: USAGE_LIMIT_RE.test(stderr) || USAGE_LIMIT_RE.test(stdout), error: `unparseable CLI output: ${(stderr || stdout).slice(0, 300)}` };
    }
    const text = typeof j.result === 'string' ? j.result : '';
    if (j.is_error || j.subtype !== 'success') {
        return { ok: false, usageLimited: USAGE_LIMIT_RE.test(text) || USAGE_LIMIT_RE.test(stderr) || j.api_error_status === 429, error: (text || j.subtype || 'error').slice(0, 300) };
    }
    let out = j.structured_output;
    if (!out) { try { out = JSON.parse(text); } catch { out = null; } }
    if (!out || !Array.isArray(out.facts)) return { ok: false, usageLimited: false, error: 'no facts in output' };
    return { ok: true, usageLimited: false, facts: out.facts, costUsd: j.total_cost_usd ?? null, numTurns: j.num_turns ?? null };
}

export function runClaude(prompt, { model, schema, timeoutMs = 30 * 60 * 1000, killGraceMs = 5000, bin = 'claude', spawnImpl = spawn } = {}) {
    return new Promise(resolve => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-'));
        let settled = false, timer = null, graceTimer = null;
        const done = r => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fs.rmSync(cwd, { recursive: true, force: true });
            resolve(r);
        };
        let out = '', err = '';
        let child;
        try {
            child = spawnImpl(bin, buildClaudeArgs({ model, schema }), { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            return done({ ok: false, usageLimited: false, error: `spawn failed: ${e.message}` });
        }
        timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch {}
            graceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, killGraceMs);
            graceTimer.unref?.();
            done({ ok: false, usageLimited: false, error: `timed out after ${timeoutMs} ms` });
        }, timeoutMs);
        child.stdin.on('error', () => {}); // EPIPE if the CLI exits early; close + parser report the outcome
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('error', e => { clearTimeout(graceTimer); done({ ok: false, usageLimited: false, error: `spawn failed: ${e.message}` }); });
        child.on('close', () => { clearTimeout(graceTimer); done(parseClaudeResult(out, err)); });
        child.stdin.end(prompt);
    });
}
