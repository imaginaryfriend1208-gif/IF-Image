// IF Image - Unit tests for chat placement (src/llm/placements.js) and
// the engine's planChatImages() (src/llm/engine.js, mocked client).
// Run: node scripts/test-llm-placements.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSize, resolveAnchor, validatePlacements } from '../src/llm/placements.js';
import { createEngine } from '../src/llm/engine.js';

// ------------------------------------------------------------------
// parseSize
// ------------------------------------------------------------------
test('parseSize: valid "832x1216"', () => {
    assert.deepEqual(parseSize('832x1216'), { width: 832, height: 1216 });
});

test('parseSize: valid lowercase "832x1216"', () => {
    assert.deepEqual(parseSize('832x1216'), { width: 832, height: 1216 });
});

test('parseSize: invalid "abc"', () => {
    assert.equal(parseSize('abc'), null);
});

test('parseSize: out of range', () => {
    assert.equal(parseSize('99999x99999'), null);
});

test('parseSize: non-string', () => {
    assert.equal(parseSize(832), null);
    assert.equal(parseSize(null), null);
    assert.equal(parseSize(undefined), null);
});

// ------------------------------------------------------------------
// resolveAnchor
// ------------------------------------------------------------------
const chat = [
    { role: 'user', mes: 'Hello there, how are you?' },
    { role: 'char', mes: 'I am fine, thank you. The sun is shining today.' },
    { role: 'user', mes: 'Let us go for a walk.' },
    { role: 'char', mes: 'She smiled and closed the door behind her.' },
    { role: 'user', mes: 'Where are we going?' },
    { role: 'char', mes: 'To the old castle at the edge of the forest.' },
];

test('resolveAnchor: exact substring match', () => {
    assert.equal(resolveAnchor(chat, 'closed the door behind her'), 3);
});

test('resolveAnchor: normalized match (punctuation)', () => {
    assert.equal(resolveAnchor(chat, 'closed the door behind her.'), 3);
});

test('resolveAnchor: normalized match (case)', () => {
    assert.equal(resolveAnchor(chat, 'SHE SMILED AND CLOSED'), 3);
});

test('resolveAnchor: fuzzy fallback (Jaccard >= 0.5)', () => {
    // "old castle edge forest" — 3/4 tokens in message 5's tail
    assert.equal(resolveAnchor(chat, 'old castle at the forest'), 5);
});

test('resolveAnchor: no match returns null', () => {
    assert.equal(resolveAnchor(chat, 'completely unrelated text about dragons'), null);
});

test('resolveAnchor: onlyCharacter=false includes user messages', () => {
    assert.equal(resolveAnchor(chat, 'Let us go for a walk', { onlyCharacter: false }), 2);
});

test('resolveAnchor: onlyCharacter=true skips user messages', () => {
    assert.equal(resolveAnchor(chat, 'Let us go for a walk', { onlyCharacter: true }), null);
});

test('resolveAnchor: empty anchor returns null', () => {
    assert.equal(resolveAnchor(chat, ''), null);
    assert.equal(resolveAnchor(chat, '   '), null);
    assert.equal(resolveAnchor(chat, null), null);
});

test('resolveAnchor: empty chat returns null', () => {
    assert.equal(resolveAnchor([], 'anything'), null);
});

// ------------------------------------------------------------------
// validatePlacements
// ------------------------------------------------------------------
test('validatePlacements: valid JSON returns placements', () => {
    const parsed = {
        images: [
            { anchor: 'closed the door behind her', prompt: '1girl, silver hair, closing door', negative: 'lowres', size: '832x1216' },
            { anchor: 'old castle at the edge', prompt: '1girl, castle, forest', size: '1216x832' },
        ],
    };
    const result = validatePlacements(parsed, chat, 3);
    assert.equal(result.length, 2);
    assert.equal(result[0].messageId, 3);
    assert.equal(result[0].prompt, '1girl, silver hair, closing door');
    assert.equal(result[0].negative, 'lowres');
    assert.deepEqual({ width: result[0].width, height: result[0].height }, { width: 832, height: 1216 });
    assert.equal(result[1].messageId, 5);
});

test('validatePlacements: clamps to count', () => {
    const parsed = {
        images: [
            { anchor: 'closed the door behind her', prompt: 'a' },
            { anchor: 'old castle at the edge', prompt: 'b' },
            { anchor: 'sun is shining today', prompt: 'c' },
        ],
    };
    const result = validatePlacements(parsed, chat, 2);
    assert.equal(result.length, 2);
});

test('validatePlacements: skips unmatched anchors', () => {
    const parsed = {
        images: [
            { anchor: 'nonexistent anchor text', prompt: 'a' },
            { anchor: 'closed the door behind her', prompt: 'b' },
        ],
    };
    const result = validatePlacements(parsed, chat, 3);
    assert.equal(result.length, 1);
    assert.equal(result[0].messageId, 3);
});

test('validatePlacements: skips duplicate messages', () => {
    const parsed = {
        images: [
            { anchor: 'closed the door behind her', prompt: 'a' },
            { anchor: 'She smiled and closed the door', prompt: 'b' },
        ],
    };
    const result = validatePlacements(parsed, chat, 3);
    assert.equal(result.length, 1);
});

test('validatePlacements: skips missing prompt', () => {
    const parsed = {
        images: [
            { anchor: 'closed the door behind her', prompt: '' },
            { anchor: 'old castle at the edge', prompt: 'b' },
        ],
    };
    const result = validatePlacements(parsed, chat, 3);
    assert.equal(result.length, 1);
    assert.equal(result[0].messageId, 5);
});

test('validatePlacements: non-object / missing images array', () => {
    assert.deepEqual(validatePlacements(null, chat, 3), []);
    assert.deepEqual(validatePlacements({}, chat, 3), []);
    assert.deepEqual(validatePlacements({ images: 'nope' }, chat, 3), []);
});

test('validatePlacements: onlyCharacter=false includes user messages', () => {
    const parsed = {
        images: [
            { anchor: 'Let us go for a walk', prompt: 'a' },
        ],
    };
    const result = validatePlacements(parsed, chat, 3, { onlyCharacter: false });
    assert.equal(result.length, 1);
    assert.equal(result[0].messageId, 2);
});

// ------------------------------------------------------------------
// engine.planChatImages (mocked client)
// ------------------------------------------------------------------
function makeEngine({ llmReply, settings = {}, chat = [], roster = {} } = {}) {
    const calls = [];
    const client = {
        async request({ type, systemPrompt, userPrompt, profileId, signal }) {
            calls.push({ type, systemPrompt, userPrompt, profileId, signal });
            return { text: llmReply, method: 'mock', elapsedMs: 42 };
        },
    };
    const engine = createEngine({
        getSettings: () => ({
            llm: { defaultApiProfileId: 'prof_1', chatPlace: { count: 3, onlyCharacter: true, maxChatWindow: 40 } },
            generation: { profile: 'anima' },
            ...settings,
        }),
        getContext: () => ({ chat }),
        roster: () => roster,
        substituteParams: (t) => t,
        compile: (content) => ({ profileKey: 'anima', envelope: { prompt: content, negative: '', params: {} } }),
        notify: () => {},
        llmClient: client,
    });
    return { engine, calls };
}

test('planChatImages: calls client with type chat_place and returns placements', async () => {
    const chat = [
        { role: 'user', mes: 'Hello' },
        { role: 'char', mes: 'She smiled and closed the door behind her.' },
    ];
    const { engine, calls } = makeEngine({
        chat,
        llmReply: JSON.stringify({
            images: [
                { anchor: 'closed the door behind her', prompt: '1girl, silver hair, closing door', size: '832x1216' },
            ],
        }),
    });
    const result = await engine.planChatImages(1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'chat_place');
    assert.equal(calls[0].profileId, 'prof_1');
    assert.match(calls[0].systemPrompt, /image placement planner/);
    assert.match(calls[0].userPrompt, /Plan 1 image placements/);
    assert.equal(result.placements.length, 1);
    assert.equal(result.placements[0].messageId, 1);
    assert.equal(result.placements[0].prompt, '1girl, silver hair, closing door');
    assert.equal(result.method, 'mock');
    assert.equal(result.elapsedMs, 42);
});

test('planChatImages: LLM returns garbage JSON → empty placements, no throw', async () => {
    const chat = [
        { role: 'user', mes: 'Hello' },
        { role: 'char', mes: 'She smiled and closed the door behind her.' },
    ];
    const { engine } = makeEngine({ chat, llmReply: 'this is not json at all' });
    const result = await engine.planChatImages(3);
    assert.deepEqual(result.placements, []);
});

test('planChatImages: LLM returns JSON with unmatched anchors → empty placements', async () => {
    const chat = [
        { role: 'user', mes: 'Hello' },
        { role: 'char', mes: 'She smiled and closed the door behind her.' },
    ];
    const { engine } = makeEngine({
        chat,
        llmReply: JSON.stringify({ images: [{ anchor: 'totally wrong anchor', prompt: 'x' }] }),
    });
    const result = await engine.planChatImages(3);
    assert.deepEqual(result.placements, []);
});

test('planChatImages: onlyCharacter=false from settings', async () => {
    const chat = [
        { role: 'user', mes: 'Let us go for a walk.' },
        { role: 'char', mes: 'She smiled and closed the door behind her.' },
    ];
    const { engine } = makeEngine({
        chat,
        llmReply: JSON.stringify({ images: [{ anchor: 'Let us go for a walk', prompt: 'x' }] }),
        settings: { llm: { defaultApiProfileId: 'prof_1', chatPlace: { count: 3, onlyCharacter: false, maxChatWindow: 40 } } },
    });
    const result = await engine.planChatImages(1);
    assert.equal(result.placements.length, 1);
    assert.equal(result.placements[0].messageId, 0);
});

test('planChatImages: chat_place mapping wins over image_gen fallback', async () => {
    const chat = [{ role: 'char', mes: 'She smiled.' }];
    const { engine, calls } = makeEngine({
        chat,
        llmReply: JSON.stringify({ images: [{ anchor: 'She smiled', prompt: 'x' }] }),
        settings: {
            llm: {
                defaultApiProfileId: 'prof_default',
                requestMapping: {
                    chat_place: { apiProfileId: 'prof_chatplace' },
                    image_gen: { apiProfileId: 'prof_imagegen' },
                },
                apiProfiles: [
                    { id: 'prof_default', name: 'Default' },
                    { id: 'prof_chatplace', name: 'ChatPlace' },
                    { id: 'prof_imagegen', name: 'ImageGen' },
                ],
                chatPlace: { count: 3, onlyCharacter: true, maxChatWindow: 40 },
            },
        },
    });
    const result = await engine.planChatImages(1);
    assert.equal(calls[0].profileId, 'prof_chatplace');
    assert.equal(result.placements.length, 1);
});