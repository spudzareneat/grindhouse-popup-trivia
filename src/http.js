export const USER_AGENT = 'grindhouse-popup-trivia/0.1 (+https://github.com/spudzareneat/grindhouse-popup-trivia)';

async function get(fetchImpl, url, headers, timeoutMs) {
    const r = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.slice(0, 120)}`);
    return r;
}
export async function getJson(fetchImpl, url, headers = {}, timeoutMs = 20000) {
    return (await get(fetchImpl, url, headers, timeoutMs)).json();
}
export async function getText(fetchImpl, url, headers = {}, timeoutMs = 20000) {
    return (await get(fetchImpl, url, headers, timeoutMs)).text();
}
