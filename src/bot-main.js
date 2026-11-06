// Discord bot process: handles picker button clicks. Exits 0 (no restart spin) when not configured.
import path from 'node:path';
import { makeDiscordApi } from './discord/api.js';
import { makePendingStore } from './discord/pending.js';
import { connectGateway } from './discord/gateway.js';
import { makeInteractionHandler, recoverInterrupted, makeSaveChoice, makeRunMovie } from './discord/bot.js';
import { makeGit } from './publish.js';

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;
const ownerId = process.env.DISCORD_OWNER_ID;
const missing = ['DISCORD_BOT_TOKEN', 'DISCORD_CHANNEL_ID', 'DISCORD_OWNER_ID'].filter((k) => !process.env[k]);
if (missing.length) {
    log(`Discord bot disabled: missing ${missing.join(', ')}`);
    process.exit(0);
}

const repoDir = path.resolve(process.env.DATA_REPO_DIR || process.cwd());
const api = makeDiscordApi({ token, channelId });
const store = makePendingStore(path.join(repoDir, '.cache', 'discord-pending.json'));

await recoverInterrupted({ api, store, log });
const onInteraction = makeInteractionHandler({
    api, store, ownerId, channelId, log,
    saveChoice: makeSaveChoice({ repoDir, git: makeGit(repoDir) }),
    runMovie: makeRunMovie(),
});
connectGateway({ token, api, onInteraction, log });
log('Discord bot started');
