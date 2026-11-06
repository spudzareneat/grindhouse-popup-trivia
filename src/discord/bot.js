// Click handling for the Discord pickers, plus the side-effect factories used by src/bot-main.js.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPicker, parsePickId } from './format.js';
import { overrideKey, saveOverride } from '../overrides.js';
import { withLock } from '../lock.js';

const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));
const EPHEMERAL = 64;

export function makeInteractionHandler({ api, store, ownerId, channelId, saveChoice, runMovie, log = () => {} }) {
    let chain = Promise.resolve();
    const enqueue = (work) => {
        const p = chain.then(work);
        chain = p.catch(() => {});
        return p;
    };

    return async function handle(interaction) {
        if (interaction?.type !== 3 || interaction.channel_id !== channelId) return;
        const userId = interaction.member?.user?.id ?? interaction.user?.id;
        if (userId !== ownerId) {
            await api.ackInteraction(interaction, 4, { content: 'Only the owner can use this', flags: EPHEMERAL });
            return;
        }
        const pick = parsePickId(interaction.data?.custom_id);
        if (!pick) return;

        const entry = store.get(pick.id);
        if (!entry) {
            await api.ackInteraction(interaction, 7, { content: 'This picker has expired.', components: [] });
            return;
        }
        // The id comes from the interaction payload: only a tconst this picker actually offered may reach the CLI.
        if (pick.tconst !== null && !(/^tt\d+$/.test(pick.tconst)
            && ((entry.candidates ?? []).some((c) => c.tconst === pick.tconst) || pick.tconst === entry.guessTconst))) {
            log(`discord: ignoring pick ${JSON.stringify(pick.tconst)} not offered by ${entry.id}`);
            return;
        }
        if (entry.status !== 'open') {
            await api.ackInteraction(interaction, 6);
            return;
        }
        // Double-click guard: flip to running synchronously, before any await.
        store.update(entry.id, { status: 'running' });

        const messageId = interaction.message?.id ?? entry.messageId;
        const edit = (payload) => api.editMessage(messageId, payload);
        // On any failure after a pick the wrong best-guess file is still published; say so.
        const stillPublished = entry.guessTconst ? ` The best-guess file for this title (${entry.guessTconst}) is still published.` : '';
        const reopen = async (why) => {
            store.update(entry.id, { status: 'open' });
            const picker = buildPicker(entry);
            await edit({ content: `${why}\n${picker.content}`, components: picker.components });
        };

        const isNone = pick.tconst === null;
        const isGuess = !isNone && pick.tconst === entry.guessTconst;
        const queued = isNone ? 'Saving...' : isGuess ? 'Confirming...' : 'Queued...';

        try {
            await api.ackInteraction(interaction, 7, { content: queued, components: [] });
        } catch (err) {
            store.update(entry.id, { status: 'open' });
            throw err;
        }

        return enqueue(async () => {
            try {
                try {
                    await saveChoice({ entry, tconst: pick.tconst });
                } catch (err) {
                    log(`discord: saving choice for ${entry.id} failed: ${err?.message ?? err}`);
                    await reopen(`Could not save the choice: ${err?.message ?? err}.${stillPublished}`);
                    return;
                }
                if (isNone) {
                    store.update(entry.id, { status: 'dismissed' });
                    await edit({ content: `Dismissed "${entry.scheduleTitle}" - no match recorded.`, components: [] });
                    return;
                }
                if (isGuess) {
                    store.update(entry.id, { status: 'done' });
                    await edit({ content: `Confirmed "${entry.scheduleTitle}".`, components: [] });
                    return;
                }
                let res;
                try {
                    res = await runMovie({ tconst: pick.tconst, replaces: entry.guessTconst ?? null });
                } catch (err) {
                    res = { ok: false, reason: err?.message ?? String(err) };
                }
                if (res?.ok) {
                    store.update(entry.id, { status: 'done' });
                    const content = res.skipped
                        ? (res.removed
                            ? `${pick.tconst} already existed; removed guess ${res.removed} for "${entry.scheduleTitle}".`
                            : `${pick.tconst} already existed for "${entry.scheduleTitle}"; nothing generated.`)
                        : `Done: generated ${pick.tconst} for "${entry.scheduleTitle}".`;
                    await edit({ content, components: [] });
                } else {
                    await reopen(`Failed: ${res?.reason ?? 'unknown error'}.${stillPublished}`);
                }
            } catch (err) {
                log(`discord: click on ${entry.id} failed: ${err?.message ?? err}`);
            }
        });
    };
}

// Entries left `running` by a previous bot process go back to `open` so the click can be retried.
export async function recoverInterrupted({ api, store, log = () => {} }) {
    for (const entry of store.list()) {
        if (entry.status !== 'running') continue;
        store.update(entry.id, { status: 'open' });
        if (!entry.messageId) continue;
        try {
            const picker = buildPicker(entry);
            await api.editMessage(entry.messageId, {
                content: `Interrupted - click again\n${picker.content}`,
                components: picker.components,
            });
        } catch (err) {
            log(`discord: could not edit interrupted picker ${entry.id}: ${err?.message ?? err}`);
        }
    }
}

// Records the choice as an override and pushes it. The lock is released before returning,
// so a following runMovie (which takes the lock itself) cannot deadlock.
export function makeSaveChoice({ repoDir, git, lockOpts }) {
    const file = path.join(repoDir, 'overrides', 'title-overrides.json');
    const lockFile = path.join(repoDir, '.cache', 'run.lock');
    return ({ entry, tconst }) => withLock(lockFile, async () => {
        git.pull();
        const key = overrideKey(entry.scheduleTitle, entry.scheduleYear);
        saveOverride(file, key, tconst ? { tconst } : { dismissed: true });
        git.commitAndPush(file, tconst
            ? `Override: ${entry.scheduleTitle} -> ${tconst}`
            : `Override: dismiss ${entry.scheduleTitle}`);
    }, lockOpts);
}

export function makeRunMovie({ spawnImpl = spawn, cliPath = CLI_PATH, env = process.env } = {}) {
    return ({ tconst, replaces }) => new Promise((resolve) => {
        const args = [cliPath, 'movie', tconst, ...(replaces ? ['--replaces', replaces] : [])];
        let out = '';
        let child;
        try {
            child = spawnImpl(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ ok: false, reason: String(err?.message ?? err).slice(0, 200) });
            return;
        }
        const grab = (d) => { out += d.toString(); };
        child.stdout?.on('data', grab);
        child.stderr?.on('data', grab);
        child.on('error', (err) => resolve({ ok: false, reason: String(err?.message ?? err).slice(0, 200) }));
        child.on('close', (code) => {
            if (code === 0) {
                // The CLI's last line is "<ISO time> <status>[: reason][ - removed ttN]"; a skipped film was not generated.
                const lastLine = out.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
                if (/^(?:\S+\s+)?skipped\b/.test(lastLine)) {
                    const removed = /removed (tt\d+)/.exec(lastLine)?.[1];
                    return resolve({ ok: true, skipped: true, ...(removed ? { removed } : {}) });
                }
                return resolve({ ok: true });
            }
            const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            resolve({ ok: false, reason: (lines.at(-1) ?? `exit code ${code}`).slice(0, 200) });
        });
    });
}
