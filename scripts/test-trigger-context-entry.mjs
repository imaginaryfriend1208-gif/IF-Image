#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const file of ['index.js', 'src/ui.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    if (!source.includes('parseTriggers(')) continue;
    assert.match(source, /import\s*\{[^}]*buildTriggerContext[^}]*\}\s*from\s*['"][^'"]*prompt\/binding\.js['"]/, `${file} calls parseTriggers() without importing buildTriggerContext`);
}

const forbiddenVisualFields = /(?:description|personality|scenario|mes_example|first_mes|persona_description)/;
for (const file of ['src/prompt/triggers.js', 'src/storage/chars.js', 'src/storage/presets.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, forbiddenVisualFields, `${file} must not read visual data from SillyTavern`);
}

console.log('PASS (2 cases)');
