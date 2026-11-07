import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { minimalFetch } from '../src/http.js';

// Reddit 403s Node's fetch (it adds sec-fetch-mode, accept-language: * ...) but accepts a request
// that carries only a User-Agent, like curl. These tests pin that: only the headers we pass go out.
async function serve(handler) {
    const server = http.createServer(handler);
    await new Promise(res => server.listen(0, '127.0.0.1', res));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

test('minimalFetch sends only the given headers and returns a fetch-shaped response', async () => {
    let seen;
    const s = await serve((req, res) => { seen = req.headers; res.end('hello'); });
    try {
        const r = await minimalFetch(`${s.url}/x`, { headers: { 'User-Agent': 'UA-test' } });
        assert.equal(r.ok, true);
        assert.equal(r.status, 200);
        assert.equal(await r.text(), 'hello');
        assert.equal(seen['user-agent'], 'UA-test');
        for (const h of ['sec-fetch-mode', 'accept-language', 'accept-encoding', 'accept']) assert.equal(seen[h], undefined, `${h} must not be sent`);
    } finally { s.close(); }
});

test('minimalFetch reports non-2xx as ok:false with the status and still readable body', async () => {
    const s = await serve((req, res) => { res.statusCode = 403; res.end('blocked'); });
    try {
        const r = await minimalFetch(s.url);
        assert.equal(r.ok, false);
        assert.equal(r.status, 403);
        assert.equal(await r.text(), 'blocked');
    } finally { s.close(); }
});

test('minimalFetch follows relative redirects and gives up after the limit', async () => {
    const s = await serve((req, res) => {
        if (req.url === '/loop') { res.statusCode = 302; res.setHeader('Location', '/loop'); return res.end(); }
        if (req.url === '/a') { res.statusCode = 302; res.setHeader('Location', '/b'); return res.end(); }
        res.end('landed');
    });
    try {
        assert.equal(await (await minimalFetch(`${s.url}/a`)).text(), 'landed');
        await assert.rejects(minimalFetch(`${s.url}/loop`, { maxRedirects: 2 }), /too many redirects/);
    } finally { s.close(); }
});

test('minimalFetch decodes a gzip body even though it never asked for compression', async () => {
    const s = await serve((req, res) => { res.setHeader('Content-Encoding', 'gzip'); res.end(zlib.gzipSync('squeezed')); });
    try {
        assert.equal(await (await minimalFetch(s.url)).text(), 'squeezed');
    } finally { s.close(); }
});

test('minimalFetch rejects when its abort signal fires', async () => {
    const s = await serve(() => { /* never answers */ });
    try {
        await assert.rejects(minimalFetch(s.url, { signal: AbortSignal.timeout(50) }));
    } finally { s.close(); }
});
