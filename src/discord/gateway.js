// Minimal Discord Gateway (v10) client: receives INTERACTION_CREATE dispatches.
// No RESUME: every reconnect is a full re-identify.

export function connectGateway({
    token,
    api,
    onInteraction,
    log = () => {},
    WebSocketImpl = WebSocket,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    backoffMs = 5000,
}) {
    let stopped = false;
    let current = null;
    let hbTimer = null;
    let reconnectTimer = null;
    let seq = null;
    let unacked = 0;

    function stopHeartbeat() {
        if (hbTimer) clearTimeoutImpl(hbTimer);
        hbTimer = null;
    }

    function scheduleReconnect() {
        if (stopped || reconnectTimer) return;
        reconnectTimer = setTimeoutImpl(() => {
            reconnectTimer = null;
            connect();
        }, backoffMs);
    }

    // Tear down `sock` (once) and schedule a reconnect.
    function down(sock, reason) {
        if (sock !== current) return;
        current = null;
        stopHeartbeat();
        log(`discord gateway: ${reason}`);
        try { sock.close(); } catch { /* already closed */ }
        scheduleReconnect();
    }

    function heartbeat(sock) {
        unacked++;
        sock.send(JSON.stringify({ op: 1, d: seq }));
    }

    function startHeartbeat(sock, interval) {
        stopHeartbeat();
        hbTimer = setTimeoutImpl(function beat() {
            if (sock !== current) return;
            if (unacked >= 2) {
                down(sock, 'heartbeat not acknowledged, reconnecting');
                return;
            }
            heartbeat(sock);
            hbTimer = setTimeoutImpl(beat, interval);
        }, interval);
    }

    function dispatch(d) {
        const fail = (err) => log(`discord gateway: interaction handler failed: ${err?.message ?? err}`);
        try { Promise.resolve(onInteraction(d)).catch(fail); } catch (err) { fail(err); }
    }

    function onMessage(sock, event) {
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        switch (frame.op) {
            case 10:
                unacked = 0;
                startHeartbeat(sock, frame.d.heartbeat_interval);
                sock.send(JSON.stringify({
                    op: 2,
                    d: {
                        token,
                        intents: 0,
                        properties: { os: 'linux', browser: 'grindhouse', device: 'grindhouse' },
                    },
                }));
                break;
            case 1:
                heartbeat(sock);
                break;
            case 11:
                unacked = 0;
                break;
            case 7:
                down(sock, 'server requested reconnect');
                break;
            case 9:
                down(sock, 'invalid session');
                break;
            case 0:
                if (typeof frame.s === 'number') seq = frame.s;
                if (frame.t === 'INTERACTION_CREATE') dispatch(frame.d);
                break;
            default:
        }
    }

    async function connect() {
        if (stopped) return;
        let url;
        try {
            url = await api.gatewayUrl();
        } catch (err) {
            log(`discord gateway: could not fetch gateway url: ${err?.message ?? err}`);
            scheduleReconnect();
            return;
        }
        if (stopped) return;
        seq = null;
        unacked = 0;
        let sock;
        try {
            sock = new WebSocketImpl(url);
        } catch (err) {
            log(`discord gateway: could not open socket: ${err?.message ?? err}`);
            scheduleReconnect();
            return;
        }
        current = sock;
        sock.addEventListener('message', (e) => onMessage(sock, e));
        sock.addEventListener('close', () => down(sock, 'socket closed'));
        sock.addEventListener('error', () => down(sock, 'socket error'));
    }

    connect();

    return {
        close() {
            stopped = true;
            stopHeartbeat();
            if (reconnectTimer) clearTimeoutImpl(reconnectTimer);
            reconnectTimer = null;
            const sock = current;
            current = null;
            if (sock) {
                try { sock.close(); } catch { /* ignore */ }
            }
        },
    };
}
