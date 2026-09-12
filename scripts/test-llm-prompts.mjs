// IF Image - Unit tests for src/llm/prompts.js.
//
// The default system prompt is the contract between the model and the
// compiler, so the things these tests pin are correctness, not style:
// telling the model to copy appearance tags (instead of referencing a
// $token) or to emit LoRA/quality tags produces duplicated or misplaced
// text in every generated image.
//
// Run: node scripts/test-llm-prompts.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    HARD_RULES, DIALECT_RULES,
    renderDefaultSystemPrompt, renderSystemPrompt, renderUserPrompt, renderChatPlacePrompt,
} from '../src/llm/prompts.js';

const DEFAULT = renderDefaultSystemPrompt();

// ------------------------------------------------------------------
// The compiler contract
// ------------------------------------------------------------------
test('default prompt: teaches the $Name token and its modifier syntax', () => {
    assert.match(DEFAULT, /\$Carter/, 'shows a plain token');
    assert.match(DEFAULT, /\$Carter:back\|full\|nsfw/, 'shows piped modifiers');
    for (const mod of ['back', 'front', 'side', 'full', 'nsfw']) {
        assert.ok(DEFAULT.includes(mod), `modifier "${mod}" should be listed`);
    }
});

test('default prompt: carries the in-place example that motivated it', () => {
    // The compiler substitutes $Name where it stands, so a model that hoists
    // characters to the front destroys sentences like this one.
    assert.match(DEFAULT, /a cat walking in front of \$Carter/);
    assert.match(DEFAULT, /GOOD:/);
    assert.match(DEFAULT, /BAD:/);
});

test('default prompt: forbids emitting what the extension appends', () => {
    assert.match(DEFAULT, /NEVER emit/i);
    assert.match(DEFAULT, /<lora:/, 'names the LoRA syntax it must not emit');
    assert.match(DEFAULT, /masterpiece/, 'names the quality boilerplate it must not emit');
});

test('default prompt: states that a persona is addressed like a character', () => {
    assert.match(DEFAULT, /persona is a character/i);
});

test('HARD_RULES: rule 6 says reference the token, never copy appearance tags', () => {
    const rule6 = HARD_RULES.split('\n').find(l => l.startsWith('6.'));
    assert.ok(rule6, 'rule 6 should exist');
    assert.match(rule6, /\$Name token/);
    assert.match(rule6, /Do not copy their appearance tags/i);
});

test('HARD_RULES and the token section do not contradict each other', () => {
    // Regression: rule 6 used to demand the model "include their tags exactly
    // as given", which is the opposite of the token instruction below it.
    assert.ok(!/include their tags\/description exactly as given/i.test(HARD_RULES),
        'the copy-the-tags wording must not come back while tokens are substituted in place');
});

test('default prompt: embeds the hard rules', () => {
    assert.ok(DEFAULT.includes(HARD_RULES), 'hard rules should be part of the default prompt');
});

// ------------------------------------------------------------------
// renderSystemPrompt: override handling
// ------------------------------------------------------------------
test('renderSystemPrompt: uses the built-in header when no override is set', () => {
    const out = renderSystemPrompt('image_gen', {});
    assert.ok(out.includes('image-prompt engine'), 'built-in header should be present');
});

test('renderSystemPrompt: a non-empty override replaces the header', () => {
    const out = renderSystemPrompt('image_gen', { systemPromptOverride: 'MY OWN RULES' });
    assert.ok(out.startsWith('MY OWN RULES'), 'override should lead the prompt');
    assert.ok(!out.includes('image-prompt engine'), 'built-in header should be gone');
});

test('renderSystemPrompt: a blank or whitespace override falls back to built-in', () => {
    for (const blank of ['', '   ', '\n\t ']) {
        const out = renderSystemPrompt('image_gen', { systemPromptOverride: blank });
        assert.ok(out.includes('image-prompt engine'), `"${JSON.stringify(blank)}" should fall back`);
    }
});

test('renderSystemPrompt: a non-string override is ignored', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
        const out = renderSystemPrompt('image_gen', { systemPromptOverride: bad });
        assert.ok(out.includes('image-prompt engine'), `${JSON.stringify(bad)} should fall back`);
    }
});

test('renderSystemPrompt: live-state blocks survive an override', () => {
    // The override replaces the instruction header only — dialect rules,
    // character cards, and the scene window are assembled from real state
    // and must still reach the model.
    const out = renderSystemPrompt('image_gen', {
        systemPromptOverride: 'MY OWN RULES',
        dialect_rules: 'DIALECT MARKER',
        character_cards: 'CHARACTER MARKER',
        scene_window: 'SCENE MARKER',
    });
    assert.ok(out.includes('DIALECT MARKER'));
    assert.ok(out.includes('CHARACTER MARKER'));
    assert.ok(out.includes('SCENE MARKER'));
});

test('renderSystemPrompt: defaults to the anima dialect rules', () => {
    const out = renderSystemPrompt('image_gen', {});
    assert.ok(out.includes(DIALECT_RULES.anima));
});

test('renderSystemPrompt: reports a missing scene window rather than leaving a hole', () => {
    const out = renderSystemPrompt('image_gen', {});
    assert.match(out, /\(no scene window provided\)/);
});

// ------------------------------------------------------------------
// renderUserPrompt
// ------------------------------------------------------------------
test('renderUserPrompt: carries the scene text', () => {
    assert.match(renderUserPrompt('a girl by the window'), /a girl by the window/);
});

test('renderUserPrompt: appends previous prompt and variation hint when given', () => {
    const out = renderUserPrompt('scene', { previousPrompt: 'PREV', variationHint: 'HINT' });
    assert.match(out, /PREV/);
    assert.match(out, /HINT/);
});

test('renderUserPrompt: omits both sections when absent', () => {
    const out = renderUserPrompt('scene');
    assert.ok(!/Previous prompt/i.test(out));
    assert.ok(!/Variation hint/i.test(out));
});

test('chat placement modes give distinct together and chronological instructions', () => {
    const together = renderChatPlacePrompt({ count: 2, planning_mode: 'together' });
    const separate = renderChatPlacePrompt({ count: 2, planning_mode: 'separate' });
    assert.match(together, /spread across the conversation/);
    assert.match(separate, /oldest to newest/);
    assert.match(separate, /never merge events from later messages/);
});
