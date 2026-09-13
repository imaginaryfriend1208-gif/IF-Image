#!/usr/bin/env node
// IF Image - UI contract guard (P5 gate).
//
// The v2 UI refactor moves markup + handlers out of src/ui.js into src/ui/*.js
// one block at a time. This test makes the "move, do not delete" rule
// mechanical: every element id that existed before the refactor must still
// exist somewhere under src/ui.js + src/ui/*.js unless it is on the explicit
// REMOVED allow-list below (legacy Settings/LLM tabs replaced by Connection).
//
// It also forbids re-introducing legacy connection ids and any direct read of
// SillyTavern card/persona description fields from UI code.
//
// Pure fs test — no DOM, no ST imports. Runs at HEAD before P5 starts.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readUiSources() {
    const files = [join(root, 'src', 'ui.js')];
    const dir = join(root, 'src', 'ui');
    if (existsSync(dir)) {
        for (const f of readdirSync(dir)) if (f.endsWith('.js')) files.push(join(dir, f));
    }
    return files.map(f => ({ file: f.replace(root, ''), text: readFileSync(f, 'utf8') }));
}

function collectIds(sources) {
    const ids = new Set();
    for (const { text } of sources) {
        for (const m of text.matchAll(/id="(if_[a-z0-9_]+)"/g)) ids.add(m[1]);
    }
    return ids;
}

// ---------------------------------------------------------------------------
// Baseline: ids that must survive the refactor (moved, renamed via the RENAMED
// map, or kept in place). Snapshot taken at 252b382 (end of P6).
// ---------------------------------------------------------------------------
const REQUIRED = [
    // Generate tab (formerly "main")
    'if_main_enabled', 'if_main_gen_enabled', 'if_main_start', 'if_main_end', 'if_main_mode',
    'if_main_dryrun', 'if_main_order', 'if_main_keeplora', 'if_main_llmsize', 'if_main_active_profile',
    'if_main_style', 'if_main_style_default', 'if_main_style_setdefault', 'if_main_style_status',
    // Chat Image Planner — P5 must not touch; P7 rewrites.
    'if_plan_charonly', 'if_plan_context', 'if_plan_count', 'if_plan_include_card',
    'if_plan_include_character', 'if_plan_include_first', 'if_plan_include_injections',
    'if_plan_include_user', 'if_plan_mode', 'if_plan_result', 'if_plan_rewrite', 'if_plan_run', 'if_plan_undo',
    // Test Generate + checkpoint-profile editor (move to Generate tab)
    'if_test_cancel', 'if_test_caption', 'if_test_download', 'if_test_elapsed', 'if_test_error',
    'if_test_generate', 'if_test_image', 'if_test_output', 'if_test_prompt', 'if_test_seed',
    'if_test_triggers', 'if_test_using',
    'if_active_profile', 'if_cp_cfg', 'if_cp_delete', 'if_cp_editor_toggle', 'if_cp_height', 'if_cp_name',
    'if_cp_profile', 'if_cp_sampler', 'if_cp_save', 'if_cp_scheduler', 'if_cp_size', 'if_cp_status',
    'if_cp_steps', 'if_cp_width',
    // Character tab — full editor incl. outfits + matrix + lock seed
    'if_char_select', 'if_char_new', 'if_char_save', 'if_char_del', 'if_char_status', 'if_char_count',
    'if_char_name', 'if_char_aliases', 'if_char_facts', 'if_char_booru', 'if_char_natural',
    'if_char_views_back', 'if_char_nsfw_extra', 'if_char_negative', 'if_char_lora',
    'if_char_lock_seed', 'if_char_lock_seed_value', 'if_char_matrix',
    'if_char_outfit_add', 'if_char_outfit_common', 'if_char_outfit_name', 'if_char_outfit_tags',
    'if_char_outfits_list',
    // Persona tab
    'if_per_select', 'if_per_new', 'if_per_save', 'if_per_del', 'if_per_sync',
    'if_per_name', 'if_per_aliases', 'if_per_default', 'if_per_pov', 'if_per_avoid',
    'if_per_facts', 'if_per_booru', 'if_per_natural', 'if_per_lora',
    'if_per_krea_style', 'if_per_krea_light', 'if_per_krea_cam',
    'if_per_anima_tags', 'if_per_anima_artists',
    'if_per_illus_quality', 'if_per_illus_artists', 'if_per_illus_neg',
    // Style tab (if_style_lora is replaced by if_style_loras — see RENAMED)
    'if_style_select', 'if_style_new', 'if_style_save', 'if_style_del', 'if_style_name',
    'if_style_krea', 'if_style_krea_light', 'if_style_krea_cam',
    'if_style_anima_tags', 'if_style_anima_artists',
    'if_style_illus', 'if_style_illus_quality', 'if_style_illus_neg',
    // Preset import/export (D7)
    'if_preset_export', 'if_preset_import', 'if_preset_import_file', 'if_preset_import_mode',
    'if_preset_status', 'if_presets_status',
    // Gallery
    'if_gallery_grid', 'if_gallery_prev', 'if_gallery_next', 'if_gallery_page_label',
    'if_gallery_scope_all', 'if_gallery_lock_char', 'if_gallery_lock_apply',
    'if_gallery_prune_chat', 'if_gallery_prune_old', 'if_gallery_prune_days',
    'if_gallery_detail', 'if_gallery_detail_close', 'if_gallery_detail_delete',
    'if_gallery_detail_download', 'if_gallery_detail_img', 'if_gallery_detail_meta',
    'if_gallery_detail_regen', 'if_gallery_detail_status',
    // Advanced: log, replace rules, 3-dialect preview, cache, notifications
    'if_log_clear', 'if_log_entries', 'if_log_limit', 'if_log_refresh', 'if_log_tasks', 'if_log_tasks_refresh',
    'if_replace_add', 'if_replace_compact', 'if_replace_compact_add', 'if_replace_condition',
    'if_replace_list', 'if_replace_mode', 'if_replace_preview', 'if_replace_preview_out',
    'if_replace_replacement', 'if_replace_trigger',
    'if_render_btn', 'if_render_clear', 'if_render_input', 'if_render_insert', 'if_render_picker',
    'if_render_results',
    'if_cache_jpegq', 'if_cache_maxmb', 'if_cache_ttl', 'if_notifications',
    // NAI settings that survive inside Connection tab
    'if_nai_variety',
];

// Old id -> new id. Either the old or the new id satisfies the requirement.
const RENAMED = {
    if_style_lora: 'if_style_loras',
    if_main_profile: 'if_main_dialect',   // "profile" here means dialect; optional rename
    if_main_backend: 'if_conn_backend',   // moves into Connection tab
    if_nai_key: 'if_conn_nai_key',
    if_nai_model: 'if_conn_model',
    if_nai_test: 'if_conn_verify',
    if_nai_result: 'if_conn_image_result',
};

// Legacy connection / per-request-type LLM UI. Allowed to disappear; forbidden
// to come back once P5a lands (see LEGACY_FORBIDDEN_AFTER_P5A).
const REMOVED_ALLOWED = new Set([
    'if_sd_connection',
    'if_comfy_checkpoint', 'if_comfy_models', 'if_comfy_pass', 'if_comfy_profile', 'if_comfy_result',
    'if_comfy_test', 'if_comfy_url', 'if_comfy_user',
    'if_a1111_auth', 'if_a1111_checkpoint', 'if_a1111_cp_editor', 'if_a1111_cp_list', 'if_a1111_models',
    'if_a1111_result', 'if_a1111_test', 'if_a1111_transport', 'if_a1111_url', 'if_a1111_url_hint',
    'if_llm_default_method', 'if_llm_default_profile', 'if_llm_injection', 'if_llm_map_api', 'if_llm_map_ctx',
    'if_llm_profile_baseurl', 'if_llm_profile_del', 'if_llm_profile_key', 'if_llm_profile_maxtokens',
    'if_llm_profile_method', 'if_llm_profile_model', 'if_llm_profile_name', 'if_llm_profile_new',
    'if_llm_profile_save', 'if_llm_profile_select', 'if_llm_profile_stprofile', 'if_llm_profile_strefresh',
    'if_llm_profile_temp', 'if_llm_profiles_conflict', 'if_llm_profiles_export', 'if_llm_profiles_file',
    'if_llm_profiles_import', 'if_llm_result', 'if_llm_stprofile_hint',
    'if_llm_system_load', 'if_llm_system_prompt', 'if_llm_system_reset', 'if_llm_system_state', 'if_llm_test',
    'if_nai_key', 'if_nai_model', 'if_nai_test', 'if_nai_result', 'if_main_backend', 'if_main_profile',
    'if_style_lora',
]);

// Once the Connection tab exists, these must never be re-added.
const LEGACY_FORBIDDEN_AFTER_P5A = [
    'if_sd_connection', 'if_comfy_url', 'if_comfy_user', 'if_comfy_pass',
    'if_llm_profile_select', 'if_llm_map_api', 'if_llm_default_method',
];

// Connection-tab ids that must exist once P5a lands.
const CONNECTION_REQUIRED = [
    'if_conn_backend', 'if_conn_comfy_url', 'if_conn_comfy_auth', 'if_conn_comfy_connect',
    'if_conn_nai_key', 'if_conn_nai_verify',
    'if_conn_fetch_models', 'if_conn_model',
    'if_conn_llm_mode', 'if_conn_llm_st_profile', 'if_conn_llm_custom_url', 'if_conn_llm_custom_key',
    'if_conn_llm_custom_model', 'if_conn_llm_test',
];

let passed = 0;
function test(name, fn) {
    try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('UI contract guard');
const sources = readUiSources();
const ids = collectIds(sources);
const hasConnectionTab = ids.has('if_conn_backend');

test('every pre-refactor id survives (moved or renamed), except the REMOVED allow-list', () => {
    const missing = REQUIRED.filter(id => !ids.has(id) && !(RENAMED[id] && ids.has(RENAMED[id])));
    assert.deepEqual(missing, [], `missing ids: ${missing.join(', ')}`);
});

test('no unexpected id disappeared', () => {
    // Everything present at snapshot time is either REQUIRED, RENAMED (old side) or REMOVED_ALLOWED.
    const snapshot = new Set([...REQUIRED, ...Object.keys(RENAMED), ...REMOVED_ALLOWED]);
    const unknownGone = [...snapshot].filter(id => !ids.has(id) && !REMOVED_ALLOWED.has(id) && !(RENAMED[id] && ids.has(RENAMED[id])));
    assert.deepEqual(unknownGone, [], `ids gone without allow-list: ${unknownGone.join(', ')}`);
});

test('Planner block untouched by P5 (all if_plan_* ids present)', () => {
    const plan = REQUIRED.filter(id => id.startsWith('if_plan_'));
    const missing = plan.filter(id => !ids.has(id));
    assert.deepEqual(missing, []);
});

test('Connection tab ids present once the tab exists', () => {
    if (!hasConnectionTab) return; // pre-P5a: skip
    const missing = CONNECTION_REQUIRED.filter(id => !ids.has(id));
    assert.deepEqual(missing, [], `connection tab missing: ${missing.join(', ')}`);
});

test('legacy connection / per-type LLM ids do not return after P5a', () => {
    if (!hasConnectionTab) return;
    const back = LEGACY_FORBIDDEN_AFTER_P5A.filter(id => ids.has(id));
    assert.deepEqual(back, [], `legacy ids re-introduced: ${back.join(', ')}`);
});

test('UI code never reads ST card/persona description fields', () => {
    // Property-access patterns only, so UI label text such as
    // "Include character-card description, personality, and scenario"
    // (planner include toggles) does not trip the guard.
    const forbidden = [
        /\.description\b/, /persona_description/, /\.personality\b/, /\.scenario\b/,
        /\.mes_example\b/, /\.first_mes\b/, /power_user\.persona/,
    ];
    const hits = [];
    for (const { file, text } of sources) {
        for (const re of forbidden) {
            const m = text.match(re);
            if (m) hits.push(`${file}: ${m[0]}`);
        }
    }
    assert.deepEqual(hits, [], hits.join('\n'));
});

test('no secret value is interpolated into markup', () => {
    // Keys/passwords must be written via element.value in handlers, never
    // rendered as value="${...key...}" in a template literal.
    const bad = [];
    for (const { file, text } of sources) {
        // Match secret-looking identifiers, not any substring: `p.key` in an
        // <option value="${p.key}"> (checkpoint-profile key) is a record id.
        for (const m of text.matchAll(/value="\$\{[^}]*\b(apiKey|api_key|password|pass|token|auth|secret)\b[^}]*\}"/g)) {
            bad.push(`${file}: ${m[0]}`);
        }
    }
    assert.deepEqual(bad, []);
});

test('split files stay under budget (each src/ui/*.js ≤ 900 lines)', () => {
    const over = sources.filter(s => s.file.includes('/ui/') || s.file.includes('\\ui\\'))
        .filter(s => s.text.split('\n').length > 900).map(s => s.file);
    assert.deepEqual(over, []);
});

if (process.exitCode) { console.log(`\nFAIL (${passed} passed)`); process.exit(1); }
console.log(`PASS (${passed} cases)`);
