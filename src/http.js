import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

// A fetch-shaped GET that sends ONLY the headers it is given. Node's built-in fetch adds
// sec-fetch-mode, accept-language: * and friends, which Reddit's filter answers with a 403; a bare
// request carrying just a User-Agent (like curl) is accepted. Follows a few redirects and decodes
// gzip/deflate/br if a server compresses anyway. Resolves to { ok, status, text(), json() }.
export function minimalFetch(url, { headers = {}, signal, maxRedirects = 3 } = {}) {
    return new Promise((resolve, reject) => {
        const go = (target, redirectsLeft) => {
            const lib = target.startsWith('https:') ? https : http;
            const req = lib.get(target, { headers, signal }, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    if (redirectsLeft <= 0) return reject(new Error(`too many redirects for ${url.slice(0, 120)}`));
                    return go(new URL(res.headers.location, target).href, redirectsLeft - 1);
                }
                const enc = res.headers['content-encoding'];
                const body = enc === 'gzip' ? res.pipe(zlib.createGunzip())
                    : enc === 'deflate' ? res.pipe(zlib.createInflate())
                    : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
                    : res;
                const chunks = [];
                body.on('data', c => chunks.push(c));
                body.on('error', reject);
                res.on('error', reject);
                body.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, text: async () => text, json: async () => JSON.parse(text) });
                });
            });
            req.on('error', reject);
        };
        go(url, maxRedirects);
    });
}

export const USER_AGENT ='grindhouse-popup-trivia/0.1 (+https://github.com/spudzareneat/grindhouse-popup-trivia)';

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
