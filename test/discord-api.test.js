import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDiscordApi } from '../src/discord/api.js';
import { jsonResponse } from './helpers.js';

function setup(responder = () => jsonResponse({})) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return responder(url, opts);
    };
    return { calls, api: makeDiscordApi({ token: 'sekret', channelId: 'chan1', fetchImpl }) };
}

test('postMessage sends url, method, auth and body, returns id', async () => {
    const { api, calls } = setup(() => jsonResponse({ id: 'm1' }));
    const r = await api.postMessage({ content: 'hi' });
    assert.deepEqual(r, { id: 'm1' });
    assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/chan1/messages');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers.Authorization, 'Bot sekret');
    assert.equal(calls[0].opts.headers['User-Agent'], 'DiscordBot (grindhouse-popup-trivia, 1)');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { content: 'hi' });
});

test('editMessage PATCHes the message', async () => {
    const { api, calls } = setup(() => jsonResponse({ id: 'm9' }));
    await api.editMessage('m9', { content: 'x' });
    assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/chan1/messages/m9');
    assert.equal(calls[0].opts.method, 'PATCH');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { content: 'x' });
});

test('ackInteraction posts callback with no auth header', async () => {
    const { api, calls } = setup(() => jsonResponse({}, 204));
    await api.ackInteraction({ id: 'i1', token: 'tok' }, 7, { content: 'y' });
    assert.equal(calls[0].url, 'https://discord.com/api/v10/interactions/i1/tok/callback');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(calls[0].opts.body), { type: 7, data: { content: 'y' } });
});

test('gatewayUrl appends version and encoding', async () => {
    const { api, calls } = setup(() => jsonResponse({ url: 'wss://gw.discord.gg' }));
    assert.equal(await api.gatewayUrl(), 'wss://gw.discord.gg?v=10&encoding=json');
    assert.equal(calls[0].url, 'https://discord.com/api/v10/gateway/bot');
    assert.equal(calls[0].opts.method, 'GET');
});

test('non-OK response throws with status but not the token', async () => {
    const { api } = setup(() => jsonResponse({ message: 'boom' }, 500));
    await assert.rejects(api.postMessage({ content: 'a' }), (e) => {
        assert.match(e.message, /500/);
        assert.doesNotMatch(e.message, /sekret/);
        return true;
    });
});
