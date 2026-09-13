#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createDefaultStyle, applyStyleMigrations, STYLE_CURRENT_VERSION, bindStyle, unbindStyle } from '../src/storage/presets.js';

const fresh = createDefaultStyle('Fresh');
assert.deepEqual(fresh.loras, []);
assert.equal(fresh.loraPosition, 'prompt_start');
assert.deepEqual(fresh.binding, { cardIds: [], chatIds: [] });
assert.equal(fresh.presetVersion, STYLE_CURRENT_VERSION);

const legacy = { id: 's1', name: 'Legacy', lora: '<lora:A:0.5>, B:2' };
applyStyleMigrations(legacy);
assert.deepEqual(legacy.loras, [{ name: 'A', weight: 0.5 }, { name: 'B', weight: 2 }]);
assert.equal(legacy.loraPosition, 'prompt_start');
assert.deepEqual(legacy.binding, { cardIds: [], chatIds: [] });
const snapshot = JSON.stringify(legacy);
applyStyleMigrations(legacy);
assert.equal(JSON.stringify(legacy), snapshot);

const bound = bindStyle(fresh, 'card', 'card-a');
assert.deepEqual(bound.binding.cardIds, ['card-a']);
assert.deepEqual(unbindStyle(bound, 'card', 'card-a').binding.cardIds, []);
console.log('PASS (9 cases)');
