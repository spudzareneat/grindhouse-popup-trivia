const BASE = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (grindhouse-popup-trivia, 1)';

export function makeDiscordApi({ token, channelId, fetchImpl = fetch }) {
    async function request(method, path, { body, auth = true } = {}) {
        const headers = { 'User-Agent': USER_AGENT };
        if (auth) headers.Authorization = `Bot ${token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(`${BASE}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
            throw new Error(`Discord ${method} ${path.replace(/^(\/interactions\/[^/]+)\/[^/]+/, '$1/<token>')} failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
        }
        return res;
    }

    return {
        async postMessage(payload) {
            const res = await request('POST', `/channels/${channelId}/messages`, { body: payload });
            const data = await res.json();
            return { id: data.id };
        },
        async editMessage(messageId, payload) {
            await request('PATCH', `/channels/${channelId}/messages/${messageId}`, { body: payload });
        },
        async ackInteraction(interaction, type, payload) {
            await request('POST', `/interactions/${interaction.id}/${interaction.token}/callback`, {
                body: { type, data: payload },
                auth: false,
            });
        },
        async gatewayUrl() {
            const res = await request('GET', '/gateway/bot');
            const data = await res.json();
            return `${data.url}?v=10&encoding=json`;
        },
    };
}
