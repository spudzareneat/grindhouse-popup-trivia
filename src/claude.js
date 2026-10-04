import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Web tools only: fetched pages are untrusted, so the model gets no file/shell access
// (the container holds a deploy key and the OAuth token in env).
export const CLAUDE_TOOLS = 'WebSearch,WebFetch';
const USAGE_LIMIT_RE = /usage limit|limit reached|rate limit|out of (extra )?usage/i;
const AUTH_RE = /invalid api key|authentication|unauthorized|oauth token|please run \/login|401/i;
// Auth failures stop the run like a usage limit: every later movie would fail the same way.
const authFailure = (msg) => ({ ok: false, usageLimited: true, authError: true, error: `Claude auth failed: ${msg.slice(0, 280)}` });

// The CLI leaves per-call state behind even with --no-session-persistence: a projects/<cwd> folder
// (our cwd is a fresh temp dir every call, so one new folder per call), session-env/<id> and
// file-history/<id>. In a long-lived container that piles up forever, so each call removes its own.
export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projectDirName = cwd => cwd.replace(/[^a-zA-Z0-9]/g, '-');
export function callLeftovers(configDir, cwd, sessionId) {
    const out = [path.join(configDir, 'projects', projectDirName(cwd))];
    if (sessionId && /^[\w-]+$/.test(sessionId)) {
        out.push(path.join(configDir, 'session-env', sessionId), path.join(configDir, 'file-history', sessionId));
    }
    return out;
}

// Container-only (PRUNE_CLAUDE_STATE=1): after a whole run, clear the CLI's other scratch folders.
// Never run this on a dev machine -- these folders hold your own interactive sessions.
export const PRUNE_DIRS = ['projects', 'session-env', 'file-history', 'shell-snapshots', 'debug', 'todos', 'paste-cache', 'statsig', 'telemetry', 'backups'];
export function pruneClaudeState(configDir = claudeConfigDir(), rmImpl = fs.rmSync) {
    for (const d of PRUNE_DIRS) {
        try { rmImpl(path.join(configDir, d), { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

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
        if (AUTH_RE.test(text) || AUTH_RE.test(stderr)) return authFailure(text || stderr);
        return { ok: false, usageLimited: USAGE_LIMIT_RE.test(text) || USAGE_LIMIT_RE.test(stderr) || j.api_error_status === 429, error: (text || j.subtype || 'error').slice(0, 300) };
    }
    let out = j.structured_output;
    if (!out) { try { out = JSON.parse(text); } catch { out = null; } }
    if (!out || !Array.isArray(out.facts)) {
        if (AUTH_RE.test(text) || AUTH_RE.test(stderr)) return authFailure(text || stderr);
        if (USAGE_LIMIT_RE.test(text)) return { ok: false, usageLimited: true, error: text.slice(0, 300) };
        return { ok: false, usageLimited: false, error: 'no facts in output' };
    }
    return { ok: true, usageLimited: false, facts: out.facts, costUsd: j.total_cost_usd ?? null, numTurns: j.num_turns ?? null, sessionId: j.session_id ?? null };
}

export function runClaude(prompt, { model, schema, timeoutMs = 30 * 60 * 1000, killGraceMs = 5000, rmImpl = fs.rmSync, bin = 'claude', spawnImpl = spawn, configDir = claudeConfigDir() } = {}) {
    return new Promise(resolve => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-'));
        let settled = false, timer = null, graceTimer = null;
        const done = r => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(r);
            // best-effort: on Windows the CLI's children can briefly hold the cwd (EBUSY); a leftover empty dir is harmless
            for (const dir of [cwd, ...callLeftovers(configDir, cwd, r.sessionId)]) {
                try { rmImpl(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
            }
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
