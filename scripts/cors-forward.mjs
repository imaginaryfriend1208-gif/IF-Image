#!/usr/bin/env node
// Local CORS forwarder for A1111-compatible backends that do not send CORS
// headers (e.g. a remote ComfyUI behind an /sdapi/v1 compatibility layer).
// The browser talks to http://127.0.0.1:7862 and this process forwards to the
// target, passing the Authorization header through untouched. No credentials
// are stored or logged here. Dev/user helper; not part of the extension.
//
// Usage:  node scripts/cors-forward.mjs https://your-backend.example
import http from 'node:http';

const target = process.argv[2];
if (!target || !/^https?:\/\//.test(target)) {
    console.error('Usage: node scripts/cors-forward.mjs <https://target-base-url>');
    process.exit(1);
}
const base = target.replace(/\/+$/, '');
const PORT = 7862;

const server = http.createServer(async (req, res) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
        try {
            const headers = {};
            if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
            if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
            const upstream = await fetch(base + req.url, {
                method: req.method,
                headers,
                ...(body ? { body } : {}),
            });
            const buf = Buffer.from(await upstream.arrayBuffer());
            res.writeHead(upstream.status, {
                ...cors,
                'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
            });
            res.end(buf);
            console.log(`[cors-forward] ${req.method} ${req.url} -> ${upstream.status}`);
        } catch (err) {
            res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forward failed', detail: String(err?.message ?? err) }));
            console.error(`[cors-forward] ${req.method} ${req.url} -> upstream error`);
        }
    });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[cors-forward] http://127.0.0.1:${PORT} -> ${base}`));
