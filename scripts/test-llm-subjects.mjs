#!/usr/bin/env node
// IF Image - Canonical subject-token contract tests (Phase 5 Task 1).
// Run: node scripts/test-llm-subjects.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isSimpleName, createSubjectToken, buildSubjectCatalog,
    renderSubjectCatalog, extractSubjectTokens, resolveDeclaredSubjects,
    repairBareSubjectNames, validateScenePrompt, diffTokenSets,
} from '../src/llm/subjects.js';

const rosario = { id: 'c1', name: 'Rosario', keyword: 'rosario', aliases: ['Rosa'], binding: { cardIds: ['card_rosario.png'], chatIds: [], global: true } };
const yenka = { id: 'p1', name: 'Yenka', keyword: 'yenka', isDefault: true, aliases: [] };
const maryJane = { id: 'c2', name: 'Mary Jane', keyword: 'maryjane', aliases: [] };

function catalog(extra = {}) {
    return buildSubjectCatalog({ characters: [rosario], persona: yenka, personas: [yenka], ...extra });
}

test('token syntax matches the trigger grammar', () => {
    assert.equal(createSubjectToken({ name: 'Rosario', keyword: 'rosario', kind: 'character' }), '$rosario');
    assert.equal(createSubjectToken({ name: 'Mary Jane', keyword: 'maryjane', kind: 'character' }), '$maryjane');
    assert.equal(createSubjectToken({ name: 'Yenka', keyword: 'yenka', kind: 'persona', isDefault: true }), '$me');
    assert.equal(createSubjectToken({ name: 'Space Name', keyword: 'spacename', kind: 'persona', isDefault: false }), '$spacename');
    assert.equal(isSimpleName('Rosario'), true);
    assert.equal(isSimpleName('Mary Jane'), false);
    assert.equal(isSimpleName('me'), false);
});

test('buildSubjectCatalog emits Rosario + default persona $me', () => {
    const cat = catalog();
    assert.equal(cat.find(e => e.name === 'Rosario').token, '$rosario');
    assert.equal(cat.find(e => e.name === 'Yenka').token, '$me');
});

test('persona sharing a character name yields no $Name collision', () => {
    const twin = { id: 'p2', name: 'Rosario', keyword: 'rosario', isDefault: false };
    const cat = buildSubjectCatalog({ characters: [rosario], personas: [twin], persona: null });
    assert.equal(cat.map(e => e.token).filter(t => t === '$rosario').length, 1);
    const personaEntry = cat.find(e => e.kind === 'persona');
    assert.ok(!personaEntry || personaEntry.token !== '$rosario');
});

test('renderSubjectCatalog is identity-only, no appearance/style', () => {
    const text = renderSubjectCatalog(catalog());
    assert.match(text, /Exact token: \$rosario/);
    assert.match(text, /Exact token: \$me/);
    assert.match(text, /never replace it with a generic wording/i);
    assert.doesNotMatch(text, /masterpiece|photorealistic|1girl|long hair/i);
});

test('renderSubjectCatalog handles empty roster', () => {
    assert.equal(renderSubjectCatalog([]), '(no known subject tokens)');
});

test('extractSubjectTokens finds $rosario and $me', () => {
    const { tokens, unknown } = extractSubjectTokens('$rosario holds $me close', catalog());
    assert.deepEqual(tokens.sort(), ['$me', '$rosario']);
    assert.deepEqual(unknown, []);
});

test('extractSubjectTokens resolves $maryjane', () => {
    const cat = buildSubjectCatalog({ characters: [maryJane], persona: null });
    const { tokens, unknown } = extractSubjectTokens('a shot of $maryjane smiling', cat);
    assert.deepEqual(tokens, ['$maryjane']);
    assert.deepEqual(unknown, []);
});

test('extractSubjectTokens flags an unknown $Token', () => {
    const { tokens, unknown } = extractSubjectTokens('$rosario meets $Nobody', catalog());
    assert.deepEqual(tokens, ['$rosario']);
    assert.deepEqual(unknown, ['$Nobody']);
});

test('extractSubjectTokens ignores ${size: ...} overrides', () => {
    const { tokens, unknown } = extractSubjectTokens('$rosario ${size: "832x1216"}', catalog());
    assert.deepEqual(tokens, ['$rosario']);
    assert.deepEqual(unknown, []);
});

test('extractSubjectTokens skips protected regions', () => {
    const cat = catalog();
    assert.deepEqual(extractSubjectTokens('```\n$rosario\n```', cat).tokens, []);
    assert.deepEqual(extractSubjectTokens('image### $rosario ###', cat).tokens, []);
    assert.deepEqual(extractSubjectTokens('<span title="$rosario">x</span>', cat).tokens, []);
});

test('resolveDeclaredSubjects: legacy absence is not an error', () => {
    const r = resolveDeclaredSubjects(undefined, catalog());
    assert.equal(r.mode, 'legacy');
    assert.deepEqual(r.errors, []);
});

test('resolveDeclaredSubjects: known resolve, unknown error', () => {
    const ok = resolveDeclaredSubjects(['$rosario', '$me'], catalog());
    assert.equal(ok.mode, 'structured');
    assert.deepEqual(ok.tokens.sort(), ['$me', '$rosario']);
    assert.deepEqual(ok.errors, []);
    const bad = resolveDeclaredSubjects(['$Ghost'], catalog());
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0], /Unknown subject token/);
});

test('resolveDeclaredSubjects: non-array is a structured error', () => {
    const r = resolveDeclaredSubjects('$rosario', catalog());
    assert.equal(r.mode, 'structured');
    assert.equal(r.errors.length, 1);
});

test('repairBareSubjectNames wraps an exact bare name', () => {
    const { prompt, repaired } = repairBareSubjectNames('Rosario leans on the wall', catalog());
    assert.equal(prompt, '$rosario leans on the wall');
    assert.deepEqual(repaired, ['$rosario']);
});

test('repairBareSubjectNames repairs multiple declared names in one pass', () => {
    const cat = catalog({ characters: [rosario, maryJane] });
    const result = repairBareSubjectNames('Rosario greets Mary Jane by the door', cat, {
        requiredTokens: ['$rosario', '$maryjane'],
    });
    assert.equal(result.prompt, '$rosario greets $maryjane by the door');
    assert.deepEqual(result.repaired, ['$rosario', '$maryjane']);
    assert.deepEqual(result.unresolved, []);
});

test('repairBareSubjectNames prefers longest surface', () => {
    const mary = { id: 'c3', name: 'Mary', keyword: 'mary', aliases: [] };
    const cat = buildSubjectCatalog({ characters: [maryJane, mary], persona: null });
    const { prompt } = repairBareSubjectNames('Mary Jane waves', cat);
    assert.equal(prompt, '$maryjane waves');
});

test('repairBareSubjectNames does not double-wrap', () => {
    const { prompt, repaired } = repairBareSubjectNames('$rosario and Rosario', catalog());
    assert.equal(prompt, '$rosario and Rosario');
    assert.deepEqual(repaired, []);
});

test('repairBareSubjectNames refuses ambiguous surfaces', () => {
    const a = { id: 'c4', name: 'Alex', keyword: 'alex', aliases: ['Al'] };
    const b = { id: 'c5', name: 'Alexis', keyword: 'alexis', aliases: ['Al'] };
    const cat = buildSubjectCatalog({ characters: [a, b], persona: null });
    const { prompt } = repairBareSubjectNames('Al enters the room', cat);
    assert.equal(prompt, 'Al enters the room');
});

test('repairBareSubjectNames never touches a generic descriptor', () => {
    const { prompt, repaired } = repairBareSubjectNames('a tall muscular man beside a small woman', catalog());
    assert.equal(prompt, 'a tall muscular man beside a small woman');
    assert.deepEqual(repaired, []);
});

test('repairBareSubjectNames leaves protected regions and existing tokens alone', () => {
    const source = [
        '```Rosario```',
        '<span>Rosario</span>',
        'image### Rosario ###',
        '$rosario beside Rosario',
    ].join(' | ');
    const { prompt, repaired } = repairBareSubjectNames(source, catalog());
    assert.equal(prompt, source);
    assert.deepEqual(repaired, []);
});

test('repairBareSubjectNames uses exact Unicode word boundaries', () => {
    const cat = catalog();
    assert.equal(repairBareSubjectNames('RosarioX waits', cat).prompt, 'RosarioX waits');
    assert.equal(repairBareSubjectNames('ÉRosario waits', cat).prompt, 'ÉRosario waits');
    assert.equal(repairBareSubjectNames('(Rosario) waits', cat).prompt, '($rosario) waits');
});

test('buildSubjectCatalog applies one cap across characters and personas', () => {
    const chars = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, name: `Char${i}` }));
    const personas = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Persona${i}`, isDefault: i === 0 }));
    const cat = buildSubjectCatalog({ characters: chars, personas, persona: personas[0], includeAll: true, maxSubjects: 5 });
    assert.equal(cat.length, 5);
    assert.equal(new Set(cat.map(entry => entry.token)).size, 5);
});

test('buildSubjectCatalog emits a non-default persona by canonical keyword', () => {
    const complex = { id: 'p-complex', name: 'Mary User', keyword: 'maryuser', isDefault: false };
    const cat = buildSubjectCatalog({ characters: [], personas: [complex], includeAll: true });
    assert.equal(cat[0].token, '$maryuser');
});

test('validateScenePrompt flags LoRA and compiler-owned style as invalid', () => {
    const lora = validateScenePrompt('$rosario, <lora:secret_style:1>', catalog());
    assert.equal(lora.styleLeak, true);
    assert.equal(lora.ok, false);
    const style = validateScenePrompt('$rosario, cinematic lighting', catalog());
    assert.equal(style.styleLeak, true);
    assert.equal(style.ok, false);
});

test('validateScenePrompt rejects known tokens added outside the allowed set', () => {
    const r = validateScenePrompt('$rosario greets $me', catalog(), {
        requiredTokens: ['$rosario'],
        allowedTokens: ['$rosario'],
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.added, ['$me']);
});

test('validateScenePrompt requires exact canonical spelling', () => {
    const r = validateScenePrompt('$Rosario waits', catalog(), { requiredTokens: ['$rosario'] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.present, ['$rosario']);
    assert.deepEqual(r.nonCanonical, ['$Rosario']);
});

test('validateScenePrompt ignores protected LoRA-like text but not a real LoRA', () => {
    const protectedResult = validateScenePrompt('```<lora:not_real:1>``` $rosario', catalog());
    assert.equal(protectedResult.styleLeak, false);
    assert.equal(protectedResult.ok, true);
    const realResult = validateScenePrompt('$rosario <lora:real:1>', catalog());
    assert.equal(realResult.styleLeak, true);
    assert.equal(realResult.ok, false);
});

test('repairBareSubjectNames leaves protected regions alone', () => {
    const { prompt } = repairBareSubjectNames('```Rosario```', catalog());
    assert.equal(prompt, '```Rosario```');
});

test('validateScenePrompt passes when required tokens present', () => {
    const r = validateScenePrompt('$rosario holds $me', catalog(), { requiredTokens: ['$rosario', '$me'] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
    assert.equal(r.styleLeak, false);
});

test('validateScenePrompt reports missing required tokens', () => {
    const r = validateScenePrompt('a tall muscular man', catalog(), { requiredTokens: ['$rosario'] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['$rosario']);
});

test('validateScenePrompt flags unknown tokens and style leakage', () => {
    const bad = validateScenePrompt('$Ghost, masterpiece, photorealistic', catalog());
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.unknown, ['$Ghost']);
    assert.equal(bad.styleLeak, true);
});

test('repairBareSubjectNames converts a display name to its keyword token', () => {
    const repaired = repairBareSubjectNames('Rosario waits', catalog());
    assert.equal(repaired.prompt, '$rosario waits');
});

test('diffTokenSets detects preservation, drops, additions', () => {
    assert.equal(diffTokenSets(['$rosario', '$me'], ['$me', '$rosario']).preserved, true);
    const dropped = diffTokenSets(['$rosario', '$me'], ['$rosario']);
    assert.equal(dropped.preserved, false);
    assert.deepEqual(dropped.dropped, ['$me']);
    const added = diffTokenSets(['$rosario'], ['$rosario', '$me']);
    assert.equal(added.preserved, false);
    assert.deepEqual(added.added, ['$me']);
});
