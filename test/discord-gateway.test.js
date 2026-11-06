import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectGateway } from '../src/discord/gateway.js';

const TOKEN = 'SECRET-BOT-TOKEN-xyz';

function setup(overrides = {}) {
    const sockets = [];
    class FakeWS {
        constructor(url) {
            this.url = url;
            this.sent = [];
            this.closed = false;
            this.listeners = {};
            sockets.push(this);
        }
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
        send(data) { this.sent.push(JSON.parse(data)); }
        close() { this.closed = true; }
        emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
        push(frame) { this.emit('message', { data: JSON.stringify(frame) }); }
    }
    const timers = [];
    const setTimeoutImpl = (fn, ms) => { const t = { fn, ms, cancelled: false, fired: false }; timers.push(t); return t; };
    const clearTimeoutImpl = (t) => { if (t) t.cancelled = true; };
    const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
    const fire = (ms) => {
        const t = pending().find((x) => x.ms === ms);
        assert.ok(t, `no pending timer with ${ms}ms`);
        t.fired = true;
        t.fn();
    };
    const logs = [];
    const interactions = [];
    const gw = connectGateway({
        token: TOKEN,
        api: { gatewayUrl: async () => 'wss://gw.example?v=10&encoding=json' },
        onInteraction: (d) => { interactions.push(d); },
        log: (...a) => logs.push(a.join(' ')),
        WebSocketImpl: FakeWS,
        setTimeoutImpl,
        clearTimeoutImpl,
        backoffMs: 5000,
        ...overrides,
    });
    return { gw, sockets, fire, pending, logs, interactions };
}

const tick = () => new Promise((r) => setImmediate(r));

test('HELLO triggers IDENTIFY with intents 0 and token', async () => {
    const { sockets } = setup();
    await tick();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, 'wss://gw.example?v=10&encoding=json');
    sockets[0].push({ op: 10, d: { heartbeat_interval: 1000 } });
    const id = sockets[0].sent.find((f) => f.op === 2);
    assert.equal(id.d.token, TOKEN);
    assert.equal(id.d.intents, 0);
    assert.deepEqual(id.d.properties, { os: 'linux', browser: 'grindhouse', device: 'grindhouse' });
});

test('heartbeats are sent on the interval with the latest sequence', async () => {
    const { sockets, fire } = setup();
    await tick();
    const ws = sockets[0];
    ws.push({ op: 10, d: { heartbeat_interval: 1000 } });
    fire(1000);
    assert.deepEqual(ws.sent.filter((f) => f.op === 1), [{ op: 1, d: null }]);
    ws.push({ op: 11 });
    ws.push({ op: 0, t: 'READY', s: 7, d: {} });
    fire(1000);
    assert.deepEqual(ws.sent.filter((f) => f.op === 1).at(-1), { op: 1, d: 7 });
});

test('op 1 triggers an immediate heartbeat', async () => {
    const { sockets } = setup();
    await tick();
    sockets[0].push({ op: 10, d: { heartbeat_interval: 1000 } });
    sockets[0].push({ op: 1 });
    assert.equal(sockets[0].sent.filter((f) => f.op === 1).length, 1);
});

test('INTERACTION_CREATE reaches onInteraction', async () => {
    const { sockets, interactions } = setup();
    await tick();
    sockets[0].push({ op: 0, t: 'INTERACTION_CREATE', s: 1, d: { id: 'i1' } });
    assert.deepEqual(interactions, [{ id: 'i1' }]);
});

test('throwing or rejecting onInteraction is logged and socket stays up', async () => {
    for (const make of [() => { throw new Error('boom'); }, () => Promise.reject(new Error('boom'))]) {
        const { sockets, logs } = setup({ onInteraction: make });
        await tick();
        sockets[0].push({ op: 0, t: 'INTERACTION_CREATE', s: 1, d: {} });
        await tick();
        assert.ok(logs.some((l) => l.includes('boom')));
        assert.equal(sockets[0].closed, false);
        assert.equal(sockets.length, 1);
    }
});

test('socket close schedules reconnect opening a second socket', async () => {
    const { sockets, fire } = setup();
    await tick();
    sockets[0].push({ op: 10, d: { heartbeat_interval: 1000 } });
    sockets[0].emit('close');
    fire(5000);
    await tick();
    assert.equal(sockets.length, 2);
});

test('close() prevents reconnect and closes the socket', async () => {
    const { gw, sockets, pending } = setup();
    await tick();
    gw.close();
    assert.equal(sockets[0].closed, true);
    sockets[0].emit('close');
    assert.equal(pending().length, 0);
    assert.equal(sockets.length, 1);
});

test('op 7 and op 9 close and reconnect', async () => {
    for (const op of [7, 9]) {
        const { sockets, fire } = setup();
        await tick();
        sockets[0].push({ op: 10, d: { heartbeat_interval: 1000 } });
        sockets[0].push({ op });
        assert.equal(sockets[0].closed, true);
        fire(5000);
        await tick();
        assert.equal(sockets.length, 2);
    }
});

test('unacked heartbeats cause a reconnect', async () => {
    const { sockets, fire } = setup();
    await tick();
    sockets[0].push({ op: 10, d: { heartbeat_interval: 1000 } });
    fire(1000);
    fire(1000);
    fire(1000);
    assert.equal(sockets[0].closed, true);
    fire(5000);
    await tick();
    assert.equal(sockets.length, 2);
});

test('gateway URL failure is logged and retried after backoff', async () => {
    let calls = 0;
    const { sockets, fire, logs } = setup({
        api: { gatewayUrl: async () => { if (++calls === 1) throw new Error('nope'); return 'wss://x'; } },
    });
    await tick();
    assert.equal(sockets.length, 0);
    assert.ok(logs.some((l) => l.includes('nope')));
    fire(5000);
    await tick();
    assert.equal(sockets.length, 1);
});

test('token never appears in logs', async () => {
    const { sockets, logs } = setup({ onInteraction: () => { throw new Error('bad'); } });
    await tick();
    sockets[0].push({ op: 10, d: { heartbeat_interval: 1000 } });
    sockets[0].push({ op: 0, t: 'INTERACTION_CREATE', s: 1, d: {} });
    sockets[0].emit('error', { message: 'x' });
    assert.ok(logs.length > 0);
    assert.ok(logs.every((l) => !l.includes(TOKEN)));
});
