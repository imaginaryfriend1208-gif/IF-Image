// IF Image - Unit tests for chat placement (src/llm/placements.js) and
// the engine's planChatImages() (src/llm/engine.js, mocked client).
// Run: node scripts/test-llm-placements.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSize, resolveAnchor, validatePlacements, validateRewrites } from '../src/llm/placements.js';
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
    assert.equal(result[0].negative, '');
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
// validateRewrites
// ------------------------------------------------------------------
const planned = [
    { messageId: 3, prompt: 'draft one', negative: 'lowres' },
    { messageId: 5, prompt: 'draft two', negative: '' },
];

test('validateRewrites: merges by index and reports the changed count', () => {
    const parsed = {
        images: [
            { index: 0, prompt: 'revised one' },
            { index: 1, prompt: 'revised two' },
        ],
    };
    const { placements, changed } = validateRewrites(parsed, planned);
    assert.equal(changed, 2);
    assert.equal(placements[0].prompt, 'revised one');
    assert.equal(placements[1].prompt, 'revised two');
    // messageId is never touched by the rewrite pass.
    assert.equal(placements[0].messageId, 3);
    assert.equal(placements[1].messageId, 5);
});

test('validateRewrites: an unchanged prompt is not counted as changed', () => {
    const parsed = { images: [{ index: 0, prompt: 'draft one' }] };
    const { changed } = validateRewrites(parsed, planned);
    assert.equal(changed, 0);
});

test('validateRewrites: missing/blank prompt keeps the original', () => {
    const parsed = {
        images: [
            { index: 0, prompt: '   ' },
            { index: 1 },
        ],
    };
    const { placements, changed } = validateRewrites(parsed, planned);
    assert.equal(changed, 0);
    assert.equal(placements[0].prompt, 'draft one');
    assert.equal(placements[1].prompt, 'draft two');
});

test('validateRewrites: out-of-range and non-integer indices are ignored', () => {
    const parsed = {
        images: [
            { index: 9, prompt: 'nope' },
            { index: -1, prompt: 'nope' },
            { index: 'x', prompt: 'nope' },
            { index: 1.5, prompt: 'nope' },
        ],
    };
    const { placements, changed } = validateRewrites(parsed, planned);
    assert.equal(changed, 0);
    assert.equal(placements[0].prompt, 'draft one');
    assert.equal(placements[1].prompt, 'draft two');
});

test('validateRewrites: a repeated index only applies once', () => {
    const parsed = {
        images: [
            { index: 0, prompt: 'first wins' },
            { index: 0, prompt: 'second ignored' },
        ],
    };
    const { placements, changed } = validateRewrites(parsed, planned);
    assert.equal(changed, 1);
    assert.equal(placements[0].prompt, 'first wins');
});

test('validateRewrites: applies negative and size when valid', () => {
    const parsed = {
        images: [{ index: 0, prompt: 'revised', negative: 'bad hands', size: '1216x832' }],
    };
    const { placements } = validateRewrites(parsed, planned);
    assert.equal(placements[0].negative, '');
    assert.equal(placements[0].width, 1216);
    assert.equal(placements[0].height, 832);
});

test('validateRewrites: an invalid size leaves the dimensions alone', () => {
    const sized = [{ messageId: 3, prompt: 'draft', width: 832, height: 1216 }];
    const parsed = { images: [{ index: 0, prompt: 'revised', size: 'huge' }] };
    const { placements } = validateRewrites(parsed, sized);
    assert.equal(placements[0].width, 832);
    assert.equal(placements[0].height, 1216);
});

test('validateRewrites: garbage reply returns the plan untouched', () => {
    for (const bad of [null, {}, { images: 'nope' }, { images: [null, 3, 'x'] }]) {
        const { placements, changed } = validateRewrites(bad, planned);
        assert.equal(changed, 0);
        assert.equal(placements.length, 2);
        assert.equal(placements[0].prompt, 'draft one');
        assert.equal(placements[1].prompt, 'draft two');
    }
});

test('validateRewrites: does not mutate the input placements', () => {
    const input = [{ messageId: 3, prompt: 'draft one' }];
    validateRewrites({ images: [{ index: 0, prompt: 'revised' }] }, input);
    assert.equal(input[0].prompt, 'draft one');
});

// ------------------------------------------------------------------
// engine.planChatImages (mocked client)
// ------------------------------------------------------------------
// `llmReply` answers the chat_place call. `rewriteReply` answers the
// chat_rewrite call; pass a function to throw or vary the reply. Rewrite
// defaults to OFF here so the pre-rewrite tests below keep asserting a
// single call — the rewrite tests opt in explicitly.
function makeEngine({ llmReply, rewriteReply, settings = {}, chat = [], roster = {}, rewrite = false } = {}) {
    const calls = [];
    const client = {
        async request({ type, systemPrompt, userPrompt, profileId, signal }) {
            calls.push({ type, systemPrompt, userPrompt, profileId, signal });
            if (type === 'chat_rewrite') {
                const reply = typeof rewriteReply === 'function' ? rewriteReply() : rewriteReply;
                return { text: reply ?? '', method: 'mock', elapsedMs: 17 };
            }
            return { text: llmReply, method: 'mock', elapsedMs: 42 };
        },
    };
    const baseLlm = {
        defaultApiProfileId: 'prof_1',
        chatPlace: { count: 3, onlyCharacter: true, maxChatWindow: 40, rewrite },
    };
    const overrideLlm = settings.llm;
    const mergedLlm = overrideLlm
        ? { ...overrideLlm, chatPlace: { rewrite, ...(overrideLlm.chatPlace ?? {}) } }
        : baseLlm;
    const engine = createEngine({
        getSettings: () => ({
            generation: { profile: 'anima' },
            ...settings,
            llm: mergedLlm,
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

// ---- rewrite pass -------------------------------------------------
const rewriteChat = [
    { role: 'user', mes: 'What are you wearing?' },
    { role: 'char', mes: 'She pulled the red coat tighter and closed the door behind her.' },
    { role: 'user', mes: 'It is cold out.' },
];
const planReply = JSON.stringify({
    images: [{ anchor: 'closed the door behind her', prompt: '1girl, black dress, closing door' }],
});

test('planChatImages: rewrite pass revises the planned prompt', async () => {
    const { engine, calls } = makeEngine({
        chat: rewriteChat,
        llmReply: planReply,
        rewrite: true,
        rewriteReply: JSON.stringify({
            images: [{ index: 0, prompt: '1girl, red coat, closing door, cold weather' }],
        }),
    });
    const result = await engine.planChatImages(1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].type, 'chat_rewrite');
    assert.match(calls[1].systemPrompt, /revise image prompts/i);
    // The excerpt and the draft both reach the rewrite call.
    assert.match(calls[1].userPrompt, /red coat tighter/);
    assert.match(calls[1].userPrompt, /DRAFT PROMPT: 1girl, black dress/);
    assert.equal(result.placements[0].prompt, '1girl, red coat, closing door, cold weather');
    assert.equal(result.placements[0].messageId, 1);
    assert.equal(result.rewritten, true);
    assert.equal(result.rewriteChanged, 1);
});

test('planChatImages: rewrite off makes exactly one call', async () => {
    const { engine, calls } = makeEngine({
        chat: rewriteChat,
        llmReply: planReply,
        rewrite: false,
        rewriteReply: JSON.stringify({ images: [{ index: 0, prompt: 'should never be used' }] }),
    });
    const result = await engine.planChatImages(1);
    assert.equal(calls.length, 1);
    assert.equal(result.placements[0].prompt, '1girl, black dress, closing door');
    assert.equal(result.rewritten, false);
});

test('planChatImages: a failing rewrite keeps the planned prompts and reports the error', async () => {
    const { engine, calls } = makeEngine({
        chat: rewriteChat,
        llmReply: planReply,
        rewrite: true,
        rewriteReply: () => { throw new Error('rewrite endpoint down'); },
    });
    const result = await engine.planChatImages(1);
    assert.equal(calls.length, 2);
    assert.equal(result.placements.length, 1);
    assert.equal(result.placements[0].prompt, '1girl, black dress, closing door');
    assert.equal(result.rewritten, false);
    assert.match(result.rewriteError, /rewrite endpoint down/);
});

test('planChatImages: an unparseable rewrite reply keeps the planned prompts', async () => {
    const { engine } = makeEngine({
        chat: rewriteChat,
        llmReply: planReply,
        rewrite: true,
        rewriteReply: 'not json at all',
    });
    const result = await engine.planChatImages(1);
    assert.equal(result.placements[0].prompt, '1girl, black dress, closing door');
    assert.equal(result.rewritten, false);
    assert.match(result.rewriteError, /not valid JSON/);
});

test('planChatImages: no placements means no rewrite call', async () => {
    const { engine, calls } = makeEngine({
        chat: rewriteChat,
        llmReply: JSON.stringify({ images: [{ anchor: 'totally wrong anchor', prompt: 'x' }] }),
        rewrite: true,
        rewriteReply: JSON.stringify({ images: [] }),
    });
    const result = await engine.planChatImages(1);
    assert.equal(calls.length, 1);
    assert.deepEqual(result.placements, []);
    assert.equal(result.rewritten, false);
});

test('planChatImages: rewrite uses the chat_rewrite mapping when present', async () => {
    const { engine, calls } = makeEngine({
        chat: rewriteChat,
        llmReply: planReply,
        rewrite: true,
        rewriteReply: JSON.stringify({ images: [{ index: 0, prompt: 'revised' }] }),
        settings: {
            llm: {
                defaultApiProfileId: 'prof_default',
                requestMapping: {
                    chat_place: { apiProfileId: 'prof_chatplace' },
                    chat_rewrite: { apiProfileId: 'prof_rewrite' },
                },
                apiProfiles: [
                    { id: 'prof_default', name: 'Default' },
                    { id: 'prof_chatplace', name: 'ChatPlace' },
                    { id: 'prof_rewrite', name: 'Rewrite' },
                ],
                chatPlace: { count: 3, onlyCharacter: true, maxChatWindow: 40, rewrite: true },
            },
        },
    });
    await engine.planChatImages(1);
    assert.equal(calls[0].profileId, 'prof_chatplace');
    assert.equal(calls[1].profileId, 'prof_rewrite');
});

test('planChatImages: rewrite falls back to the chat_place profile', async () => {
    const { engine, calls } = makeEngine({
        chat: rewriteChat,
        llmReply: planReply,
        rewrite: true,
        rewriteReply: JSON.stringify({ images: [{ index: 0, prompt: 'revised' }] }),
        settings: {
            llm: {
                defaultApiProfileId: 'prof_default',
                requestMapping: { chat_place: { apiProfileId: 'prof_chatplace' } },
                apiProfiles: [
                    { id: 'prof_default', name: 'Default' },
                    { id: 'prof_chatplace', name: 'ChatPlace' },
                ],
                chatPlace: { count: 3, onlyCharacter: true, maxChatWindow: 40, rewrite: true },
            },
        },
    });
    await engine.planChatImages(1);
    assert.equal(calls[1].profileId, 'prof_chatplace');
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