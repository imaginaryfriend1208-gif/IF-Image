#!/usr/bin/env node
// Tiny mock of the comfy-cloud-forge proxy for live Tier-2 verification.
// Serves /internal/ping, /internal/status, /sdapi/v1/sd-models, and
// /sdapi/v1/txt2img (returns a fixed 1x1 PNG). Counts generation calls so
// the restore-vs-regenerate behavior can be observed. NOT part of the
// extension; dev-only helper.
import http from 'node:http';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
let genCount = 0;

const server = http.createServer((req, res) => {
    const send = (code, obj) => {
        res.writeHead(code, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        });
        res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') { send(204, {}); return; }
    if (req.url === '/internal/ping') { send(200, { ok: true, service: 'mock-proxy' }); return; }
    if (req.url === '/internal/status') { send(200, { ok: true, cloudKey: true, profiles: 3, characters: 0 }); return; }
    if (req.url === '/sdapi/v1/sd-models') {
        send(200, [{ title: 'mock-checkpoint', model_name: 'mock-checkpoint', filename: 'mock.safetensors' }]);
        return;
    }
    if (req.url === '/sdapi/v1/txt2img' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            genCount += 1;
            console.log(`[mock-proxy] txt2img #${genCount}`);
            // Prompts containing "slowtest" respond after 8s so browser-side
            // cancellation (chat switch) can be observed live.
            const delay = body.includes('slowtest') ? 8000 : 0;
            setTimeout(() => send(200, { images: [PNG_1PX], parameters: {}, info: JSON.stringify({ seed: 1234 + genCount }) }), delay);
        });
        return;
    }
    if (req.url === '/gen-count') { send(200, { genCount }); return; }
    send(404, { error: 'not found' });
});

server.listen(7861, '127.0.0.1', () => console.log('[mock-proxy] listening on http://127.0.0.1:7861'));
