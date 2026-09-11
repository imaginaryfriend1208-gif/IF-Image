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

const rosario = { id: 'c1', name: 'Rosario', aliases: ['Rosa'], binding: { cardId: 'card_rosario.png', chatIds: [] } };
const yenka = { id: 'p1', name: 'Yenka', isDefault: true, aliases: [] };
const maryJane = { id: 'c2', name: 'Mary Jane', aliases: [] };

function catalog(extra = {}) {
    return buildSubjectCatalog({ characters: [rosario], persona: yenka, personas: [yenka], ...extra });
}

test('token syntax matches the trigger grammar', () => {
    assert.equal(createSubjectToken({ name: 'Rosario', kind: 'character' }), '$Rosario');
    assert.equal(createSubjectToken({ name: 'Mary Jane', kind: 'character' }), '${char: "Mary Jane"}');
    assert.equal(createSubjectToken({ name: 'Yenka', kind: 'persona', isDefault: true }), '$me');
    assert.equal(createSubjectToken({ name: 'Space Name', kind: 'persona', isDefault: false }), '');
    assert.equal(isSimpleName('Rosario'), true);
    assert.equal(isSimpleName('Mary Jane'), false);
    assert.equal(isSimpleName('me'), false);
});

test('buildSubjectCatalog emits Rosario + default persona $me', () => {
    const cat = catalog();
    assert.equal(cat.find(e => e.name === 'Rosario').token, '$Rosario');
    assert.equal(cat.find(e => e.name === 'Yenka').token, '$me');
});

test('persona sharing a character name yields no $Name collision', () => {
    const twin = { id: 'p2', name: 'Rosario', isDefault: false };
    const cat = buildSubjectCatalog({ characters: [rosario], personas: [twin], persona: null });
    assert.equal(cat.map(e => e.token).filter(t => t === '$Rosario').length, 1);
    const personaEntry = cat.find(e => e.kind === 'persona');
    assert.ok(!personaEntry || personaEntry.token !== '$Rosario');
});

test('renderSubjectCatalog is identity-only, no appearance/style', () => {
    const text = renderSubjectCatalog(catalog());
    assert.match(text, /Exact token: \$Rosario/);
    assert.match(text, /Exact token: \$me/);
    assert.match(text, /never replace it with a generic description/i);
    assert.doesNotMatch(text, /masterpiece|photorealistic|1girl|long hair/i);
});

test('renderSubjectCatalog handles empty roster', () => {
    assert.equal(renderSubjectCatalog([]), '(no known subject tokens)');
});

test('extractSubjectTokens finds $Rosario and $me', () => {
    const { tokens, unknown } = extractSubjectTokens('$Rosario holds $me close', catalog());
    assert.deepEqual(tokens.sort(), ['$Rosario', '$me']);
    assert.deepEqual(unknown, []);
});

test('extractSubjectTokens resolves ${char: "Mary Jane"}', () => {
    const cat = buildSubjectCatalog({ characters: [maryJane], persona: null });
    const { tokens, unknown } = extractSubjectTokens('a shot of ${char: "Mary Jane"} smiling', cat);
    assert.deepEqual(tokens, ['${char: "Mary Jane"}']);
    assert.deepEqual(unknown, []);
});

test('extractSubjectTokens flags an unknown $Token', () => {
    const { tokens, unknown } = extractSubjectTokens('$Rosario meets $Nobody', catalog());
    assert.deepEqual(tokens, ['$Rosario']);
    assert.deepEqual(unknown, ['$Nobody']);
});

test('extractSubjectTokens ignores ${size: ...} overrides', () => {
    const { tokens, unknown } = extractSubjectTokens('$Rosario ${size: "832x1216"}', catalog());
    assert.deepEqual(tokens, ['$Rosario']);
    assert.deepEqual(unknown, []);
});

test('extractSubjectTokens skips protected regions', () => {
    const cat = catalog();
    assert.deepEqual(extractSubjectTokens('```\n$Rosario\n```', cat).tokens, []);
    assert.deepEqual(extractSubjectTokens('image### $Rosario ###', cat).tokens, []);
    assert.deepEqual(extractSubjectTokens('<span title="$Rosario">x</span>', cat).tokens, []);
});

test('resolveDeclaredSubjects: legacy absence is not an error', () => {
    const r = resolveDeclaredSubjects(undefined, catalog());
    assert.equal(r.mode, 'legacy');
    assert.deepEqual(r.errors, []);
});

test('resolveDeclaredSubjects: known resolve, unknown error', () => {
    const ok = resolveDeclaredSubjects(['$Rosario', '$me'], catalog());
    assert.equal(ok.mode, 'structured');
    assert.deepEqual(ok.tokens.sort(), ['$Rosario', '$me']);
    assert.deepEqual(ok.errors, []);
    const bad = resolveDeclaredSubjects(['$Ghost'], catalog());
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0], /Unknown subject token/);
});

test('resolveDeclaredSubjects: non-array is a structured error', () => {
    const r = resolveDeclaredSubjects('$Rosario', catalog());
    assert.equal(r.mode, 'structured');
    assert.equal(r.errors.length, 1);
});

test('repairBareSubjectNames wraps an exact bare name', () => {
    const { prompt, repaired } = repairBareSubjectNames('Rosario leans on the wall', catalog());
    assert.equal(prompt, '$Rosario leans on the wall');
    assert.deepEqual(repaired, ['$Rosario']);
});

test('repairBareSubjectNames repairs multiple declared names in one pass', () => {
    const cat = catalog({ characters: [rosario, maryJane] });
    const result = repairBareSubjectNames('Rosario greets Mary Jane by the door', cat, {
        requiredTokens: ['$Rosario', '${char: "Mary Jane"}'],
    });
    assert.equal(result.prompt, '$Rosario greets ${char: "Mary Jane"} by the door');
    assert.deepEqual(result.repaired, ['$Rosario', '${char: "Mary Jane"}']);
    assert.deepEqual(result.unresolved, []);
});

test('repairBareSubjectNames prefers longest surface', () => {
    const mary = { id: 'c3', name: 'Mary', aliases: [] };
    const cat = buildSubjectCatalog({ characters: [maryJane, mary], persona: null });
    const { prompt } = repairBareSubjectNames('Mary Jane waves', cat);
    assert.equal(prompt, '${char: "Mary Jane"} waves');
});

test('repairBareSubjectNames does not double-wrap', () => {
    const { prompt, repaired } = repairBareSubjectNames('$Rosario and Rosario', catalog());
    assert.equal(prompt, '$Rosario and Rosario');
    assert.deepEqual(repaired, []);
});

test('repairBareSubjectNames refuses ambiguous surfaces', () => {
    const a = { id: 'c4', name: 'Alex', aliases: ['Al'] };
    const b = { id: 'c5', name: 'Alexis', aliases: ['Al'] };
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
        '$Rosario beside Rosario',
    ].join(' | ');
    const { prompt, repaired } = repairBareSubjectNames(source, catalog());
    assert.equal(prompt, source);
    assert.deepEqual(repaired, []);
});

test('repairBareSubjectNames uses exact Unicode word boundaries', () => {
    const cat = catalog();
    assert.equal(repairBareSubjectNames('RosarioX waits', cat).prompt, 'RosarioX waits');
    assert.equal(repairBareSubjectNames('ÉRosario waits', cat).prompt, 'ÉRosario waits');
    assert.equal(repairBareSubjectNames('(Rosario) waits', cat).prompt, '($Rosario) waits');
});

test('buildSubjectCatalog applies one cap across characters and personas', () => {
    const chars = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, name: `Char${i}` }));
    const personas = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Persona${i}`, isDefault: i === 0 }));
    const cat = buildSubjectCatalog({ characters: chars, personas, persona: personas[0], includeAll: true, maxSubjects: 5 });
    assert.equal(cat.length, 5);
    assert.equal(new Set(cat.map(entry => entry.token)).size, 5);
});

test('buildSubjectCatalog omits an unresolvable complex non-default persona', () => {
    const complex = { id: 'p-complex', name: 'Mary User', isDefault: false };
    const cat = buildSubjectCatalog({ characters: [], personas: [complex], includeAll: true });
    assert.deepEqual(cat, []);
});

test('validateScenePrompt flags LoRA and compiler-owned style as invalid', () => {
    const lora = validateScenePrompt('$Rosario, <lora:secret_style:1>', catalog());
    assert.equal(lora.styleLeak, true);
    assert.equal(lora.ok, false);
    const style = validateScenePrompt('$Rosario, cinematic lighting', catalog());
    assert.equal(style.styleLeak, true);
    assert.equal(style.ok, false);
});

test('validateScenePrompt rejects known tokens added outside the allowed set', () => {
    const r = validateScenePrompt('$Rosario greets $me', catalog(), {
        requiredTokens: ['$Rosario'],
        allowedTokens: ['$Rosario'],
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.added, ['$me']);
});

test('validateScenePrompt requires exact canonical spelling', () => {
    const r = validateScenePrompt('$rosario waits', catalog(), { requiredTokens: ['$Rosario'] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.present, ['$Rosario']);
    assert.deepEqual(r.nonCanonical, ['$rosario']);
});

test('validateScenePrompt ignores protected LoRA-like text but not a real LoRA', () => {
    const protectedResult = validateScenePrompt('```<lora:not_real:1>``` $Rosario', catalog());
    assert.equal(protectedResult.styleLeak, false);
    assert.equal(protectedResult.ok, true);
    const realResult = validateScenePrompt('$Rosario <lora:real:1>', catalog());
    assert.equal(realResult.styleLeak, true);
    assert.equal(realResult.ok, false);
});

test('repairBareSubjectNames leaves protected regions alone', () => {
    const { prompt } = repairBareSubjectNames('```Rosario```', catalog());
    assert.equal(prompt, '```Rosario```');
});

test('validateScenePrompt passes when required tokens present', () => {
    const r = validateScenePrompt('$Rosario holds $me', catalog(), { requiredTokens: ['$Rosario', '$me'] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
    assert.equal(r.styleLeak, false);
});

test('validateScenePrompt reports missing required tokens', () => {
    const r = validateScenePrompt('a tall muscular man', catalog(), { requiredTokens: ['$Rosario'] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['$Rosario']);
});

test('validateScenePrompt flags unknown tokens and style leakage', () => {
    const bad = validateScenePrompt('$Ghost, masterpiece, photorealistic', catalog());
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.unknown, ['$Ghost']);
    assert.equal(bad.styleLeak, true);
});

test('diffTokenSets detects preservation, drops, additions', () => {
    assert.equal(diffTokenSets(['$Rosario', '$me'], ['$me', '$Rosario']).preserved, true);
    const dropped = diffTokenSets(['$Rosario', '$me'], ['$Rosario']);
    assert.equal(dropped.preserved, false);
    assert.deepEqual(dropped.dropped, ['$me']);
    const added = diffTokenSets(['$Rosario'], ['$Rosario', '$me']);
    assert.equal(added.preserved, false);
    assert.deepEqual(added.added, ['$me']);
});
