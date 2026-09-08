// IF Image - Drawer UI with 6 Tabs: Main, Backends, Test Generate, Characters, Persona & Styles, Test Render.
// Template literals mounted into #extensions_settings2 by index.js.

import { NAI_MODELS } from './backends/nai.js';
import { resolveCheckpoint } from './backends/a1111.js';
import { resolveCheckpointProfile, mergeParams, suggestCheckpointProfile, normalizeCheckpointProfile, SIZE_PRESETS, matchSizePreset } from './backends/checkpoint-profiles.js';
import { PROFILES, PROFILE_KEYS, applyProfile } from './profiles.js';
import { getAllCharacters, saveCharacter, removeCharacter, createDefaultCharacter, emptyBooruDetail, applyCharMigrations } from './storage/chars.js';
import { getAllPersonas, savePersona, removePersona, getAllStyles, saveStyle, removeStyle, createDefaultPersona, createDefaultStyle, getReplaceRules, saveReplaceRules } from './storage/presets.js';
import { getOutfitsForCharacter, getAllOutfits, saveOutfit, removeOutfit, createDefaultOutfit } from './storage/outfits.js';
import { buildExport, validateImport, planMerge } from './storage/transfer.js';
import { listImages, countImages, deleteImageRecord, getStorageStats, pruneImages } from './storage/images.js';
import { parseTriggers } from './prompt/triggers.js';
import { assemblePrompt, resolveProfileKey } from './prompt/render.js';
import { cleanupEnvelope } from './prompt/cleanup.js';
import { applyReplaceRules, parseCompactRule } from './prompt/replace.js';

// Single source of truth for the displayed version. Keep in sync with
// manifest.json (which cannot be imported from browser ESM without JSON
// import attributes — unsupported on older Chromium, would hard-fail the
// whole extension).
export const EXTENSION_VERSION = '0.3.0';

/**
 * @param {object} args
 * @param {object} args.settings extension_settings.IF_Image (live reference)
 * @param {() => void} args.save saveSettingsDebounced wrapper
 * @param {NaiClient} args.nai
 * @param {ComfyProxyClient} args.comfy legacy proxy client (connection 'legacy_proxy')
 * @param {A1111Client} args.a1111 AUTOMATIC1111-compatible API client (connection 'a1111')
 * @param {Array} [args.genLog] - B7: ring buffer of pipeline/LLM events
 * @param {() => object} [args.getQueue] - B7: live queue instance for task list
 * @param {(record: object) => Promise<string>} [args.regenerateImage] - C10:
 *   re-enqueue a gallery record through the existing queue/executor (seed -1)
 *   and save the result as a new record.
 * @param {() => string} [args.getCurrentChatId] - C10: current chat id, for
 *   the Gallery tab's "current chat" filter.
 */
export function renderDrawer({ settings, save, nai, comfy, a1111, genLog, getQueue, regenerateImage, getCurrentChatId }) {
    const html = `
    <div class="if-image-settings">
        <div class="if-image-title">
            <h2>IF Image</h2>
            <span>v${EXTENSION_VERSION}</span>
        </div>

        <div class="if-image-tabs">
            <button class="if-image-tab menu_button active" data-if-tab="main">Main</button>
            <button class="if-image-tab menu_button" data-if-tab="llm">LLM</button>
            <button class="if-image-tab menu_button" data-if-tab="backends">Backends</button>
            <button class="if-image-tab menu_button" data-if-tab="test">Test Gen</button>
            <button class="if-image-tab menu_button" data-if-tab="log">Log</button>
            <button class="if-image-tab menu_button" data-if-tab="chars">Characters</button>
            <button class="if-image-tab menu_button" data-if-tab="presets">Persona & Style</button>
            <button class="if-image-tab menu_button" data-if-tab="replace">Replace</button>
            <button class="if-image-tab menu_button" data-if-tab="gallery">Gallery</button>
            <button class="if-image-tab menu_button" data-if-tab="render">3-Dialect Preview</button>
        </div>

        <!-- ============ MAIN TAB ============ -->
        <div class="if-image-panel" data-if-panel="main">
            <h3>Generation</h3>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_main_enabled"> Extension enabled
                </label>
            </div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_main_gen_enabled"> Marker detection enabled
                </label>
            </div>
            <div class="if-image-row">
                <label for="if_main_start">Start tag</label>
                <input id="if_main_start" type="text" class="text_pole textarea_compact" value="image###">
            </div>
            <div class="if-image-row">
                <label for="if_main_end">End tag</label>
                <input id="if_main_end" type="text" class="text_pole textarea_compact" value="###">
            </div>
            <div class="if-image-note">Changing the tags affects marker detection in existing messages. Tags are matched literally (regex special characters are escaped).</div>
            <div class="if-image-row">
                <label for="if_main_backend">Default backend</label>
                <select id="if_main_backend" class="text_pole">
                    <option value="comfy">SD (A1111-compatible / Comfy proxy)</option>
                    <option value="nai">NovelAI</option>
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_main_profile">Default profile</label>
                <select id="if_main_profile" class="text_pole">
                    ${PROFILE_KEYS.map(k => `<option value="${k}">${PROFILES[k].label}</option>`).join('')}
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_main_checkpoint">Checkpoint (A1111-compatible SD)</label>
                <select id="if_main_checkpoint" class="text_pole">
                    <option value="">-- none selected --</option>
                </select>
            </div>
            <div class="if-image-note">Options come from the last Backends → Test connection / Refresh Models discovery. The checkpoint is re-validated against fresh discovery at generation time.</div>
            <div class="if-image-row">
                <label for="if_main_mode">Mode</label>
                <select id="if_main_mode" class="text_pole">
                    <option value="direct">Direct (marker → image)</option>
                    <option value="assist">Assist (LLM rewrite)</option>
                    <option value="full">Full (LLM replies)</option>
                </select>
            </div>
            <div class="if-image-note">Direct compiles markers locally. Assist rewrites hand-typed markers through the LLM. Full also scans LLM chat replies for &lt;ifimage&gt; blocks.</div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_main_dryrun"> Dry-run (log envelope, no generation)
                </label>
            </div>
            <div class="if-image-row">
                <label for="if_main_llmsize">LLM size hint</label>
                <select id="if_main_llmsize" class="text_pole">
                    <option value="auto">Auto (LLM &lt;size&gt; wins)</option>
                    <option value="ignore">Ignore (discard LLM size)</option>
                    <option value="force">Force (always use LLM size)</option>
                </select>
            </div>
            <div class="if-image-note">How an Assist/Full-mode LLM &lt;size&gt; hint interacts with sizes from markers and profiles. Auto and Force behave identically today.</div>

            <hr class="if-image-sep"/>
            <h3>Generation Params</h3>
            <div class="if-image-note">Overrides the profile default for markers using this profile. Blank = inherit the profile default; a marker's own "size"/"steps"/"cfg" JSON trigger wins over this.</div>
            <div class="if-image-row">
                <label for="if_params_profile">Profile</label>
                <select id="if_params_profile" class="text_pole">
                    ${PROFILE_KEYS.map(k => `<option value="${k}">${PROFILES[k].label}</option>`).join('')}
                </select>
            </div>
            <div class="if-image-grid">
                <div class="if-image-row">
                    <label for="if_params_width">Width</label>
                    <input id="if_params_width" type="number" min="256" max="2048" step="64" class="text_pole">
                </div>
                <div class="if-image-row">
                    <label for="if_params_height">Height</label>
                    <input id="if_params_height" type="number" min="256" max="2048" step="64" class="text_pole">
                </div>
                <div class="if-image-row">
                    <label for="if_params_steps">Steps</label>
                    <input id="if_params_steps" type="number" min="1" max="150" class="text_pole">
                </div>
                <div class="if-image-row">
                    <label for="if_params_cfg">CFG</label>
                    <input id="if_params_cfg" type="number" min="0" max="30" step="0.5" class="text_pole">
                </div>
            </div>
        </div>

        <!-- ============ LLM TAB ============ -->
        <div class="if-image-panel" data-if-panel="llm" style="display:none;">
            <h3>LLM API Profiles</h3>
            <div class="if-image-row">
                <label for="if_llm_default_method">Default method</label>
                <select id="if_llm_default_method" class="text_pole">
                    <option value="direct">ST generateRaw (current connection)</option>
                    <option value="st_connection_manager">ST Connection Manager profile</option>
                    <option value="direct_fetch">Direct OpenAI-compatible endpoint</option>
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_llm_default_profile">Default API profile</label>
                <select id="if_llm_default_profile" class="text_pole">
                    <option value="">-- none --</option>
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_llm_injection">Character injection style</label>
                <select id="if_llm_injection" class="text_pole">
                    <option value="compact">Compact (one line per char)</option>
                    <option value="xml">XML (structured tags)</option>
                    <option value="full">Full (multi-line sheet)</option>
                </select>
            </div>

            <hr class="if-image-sep"/>

            <h3>API Profile Editor</h3>
            <div class="if-image-row">
                <label for="if_llm_profile_select">Profile</label>
                <div style="display:flex; gap:6px;">
                    <select id="if_llm_profile_select" class="text_pole" style="flex:1;">
                        <option value="">-- New Profile --</option>
                    </select>
                    <button id="if_llm_profile_new" class="menu_button">+ New</button>
                    <button id="if_llm_profile_del" class="menu_button" style="background:#552222;">Delete</button>
                </div>
            </div>
            <div class="if-image-row">
                <label for="if_llm_profile_name">Name</label>
                <input id="if_llm_profile_name" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_llm_profile_method">Method</label>
                <select id="if_llm_profile_method" class="text_pole">
                    <option value="generateRaw">ST generateRaw</option>
                    <option value="connection_manager">ST Connection Manager</option>
                    <option value="direct_fetch">Direct fetch</option>
                </select>
            </div>
            <div class="if-image-row" data-if-llm-fetch>
                <label for="if_llm_profile_baseurl">Base URL</label>
                <input id="if_llm_profile_baseurl" type="text" class="text_pole" placeholder="https://api.example.com">
            </div>
            <div class="if-image-row" data-if-llm-fetch>
                <label for="if_llm_profile_key">API key</label>
                <input id="if_llm_profile_key" type="password" class="text_pole" autocomplete="off">
            </div>
            <div class="if-image-row" data-if-llm-fetch>
                <label for="if_llm_profile_model">Model</label>
                <input id="if_llm_profile_model" type="text" class="text_pole" placeholder="gpt-4o-mini">
            </div>
            <div class="if-image-row" data-if-llm-fetch>
                <label for="if_llm_profile_temp">Temperature</label>
                <input id="if_llm_profile_temp" type="number" min="0" max="2" step="0.1" class="text_pole">
            </div>
            <div class="if-image-row" data-if-llm-fetch>
                <label for="if_llm_profile_maxtokens">Max tokens</label>
                <input id="if_llm_profile_maxtokens" type="number" min="1" max="32768" class="text_pole">
            </div>
            <div style="display:flex; gap:6px; margin-top:4px;">
                <button id="if_llm_profile_save" class="menu_button" style="flex:1;">Save Profile</button>
                <button id="if_llm_test" class="menu_button">Test call</button>
            </div>
            <div class="if-image-result" id="if_llm_result"></div>

            <hr class="if-image-sep"/>

            <h3>Request Mapping</h3>
            <div class="if-image-row">
                <label for="if_llm_map_api">image_gen → API profile</label>
                <select id="if_llm_map_api" class="text_pole">
                    <option value="">-- none --</option>
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_llm_map_ctx">image_gen → Context profile</label>
                <select id="if_llm_map_ctx" class="text_pole">
                    <option value="">-- none --</option>
                </select>
            </div>
            <div class="if-image-note">Context profiles control the scene window and roster injection. More request types arrive in Phase C.</div>
        </div>

        <!-- ============ LOG TAB ============ -->
        <div class="if-image-panel" data-if-panel="log" style="display:none;">
            <h3>Generation Log</h3>
            <div class="if-image-row">
                <label for="if_log_limit">Log limit</label>
                <input id="if_log_limit" type="number" min="1" max="500" class="text_pole">
            </div>
            <div class="if-image-row">
                <button id="if_log_refresh" class="menu_button">Refresh</button>
                <button id="if_log_clear" class="menu_button">Clear</button>
            </div>
            <div id="if_log_entries" class="if-image-log"></div>

            <hr class="if-image-sep"/>

            <h3>Live Tasks</h3>
            <div class="if-image-row">
                <button id="if_log_tasks_refresh" class="menu_button">Refresh tasks</button>
            </div>
            <div id="if_log_tasks" class="if-image-log"></div>
        </div>

        <!-- ============ BACKENDS TAB ============ -->
        <div class="if-image-panel" data-if-panel="backends" style="display:none;">
            <h3>NovelAI</h3>
            <div class="if-image-row">
                <label for="if_nai_key">API token (pst-...)</label>
                <input id="if_nai_key" type="password" class="text_pole textarea_compact" autocomplete="off" placeholder="pst-..." value="">
            </div>
            <div class="if-image-row">
                <label for="if_nai_model">Model</label>
                <select id="if_nai_model" class="text_pole">
                    ${NAI_MODELS.map(m => `<option value="${m.value}">${m.text}</option>`).join('')}
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_nai_variety" class="checkbox_label">
                    <input id="if_nai_variety" type="checkbox">
                    <span>Variety+ (skip CFG above sigma — more varied compositions)</span>
                </label>
            </div>
            <div class="if-image-row">
                <button id="if_nai_test" class="menu_button">Test connection</button>
            </div>
            <div class="if-image-result" id="if_nai_result"></div>

            <hr class="if-image-sep"/>

            <h3>Stable Diffusion backend</h3>
            <div class="if-image-row">
                <label for="if_sd_connection">Connection type</label>
                <select id="if_sd_connection" class="text_pole">
                    <option value="legacy_proxy">Comfy Cloud Proxy (Legacy)</option>
                    <option value="a1111">AUTOMATIC1111-compatible API</option>
                </select>
            </div>

            <!-- Legacy comfy-cloud-forge-proxy block -->
            <div data-if-conn="legacy_proxy">
                <div class="if-image-row">
                    <label for="if_comfy_url">Proxy URL</label>
                    <input id="if_comfy_url" type="text" class="text_pole textarea_compact" placeholder="http://localhost:7861" value="">
                </div>
                <div class="if-image-row">
                    <label for="if_comfy_user">Username</label>
                    <input id="if_comfy_user" type="text" class="text_pole textarea_compact" autocomplete="off" value="">
                </div>
                <div class="if-image-row">
                    <label for="if_comfy_pass">Password</label>
                    <input id="if_comfy_pass" type="password" class="text_pole textarea_compact" autocomplete="off" value="">
                </div>
                <div class="if-image-row">
                    <label for="if_comfy_profile">Default profile</label>
                    <select id="if_comfy_profile" class="text_pole">
                        ${PROFILE_KEYS.map(k => `<option value="${k}">${PROFILES[k].label}</option>`).join('')}
                    </select>
                </div>
                <div class="if-image-row">
                    <div style="display:flex; gap:6px;">
                        <button id="if_comfy_test" class="menu_button">Test connection</button>
                        <button id="if_comfy_models" class="menu_button">Refresh Models</button>
                    </div>
                </div>
                <div class="if-image-row">
                    <label for="if_comfy_checkpoint">Checkpoint (proxy model)</label>
                    <select id="if_comfy_checkpoint" class="text_pole">
                        <option value="">-- Refresh Models to load --</option>
                    </select>
                </div>
                <div class="if-image-result" id="if_comfy_result"></div>
            </div>

            <!-- AUTOMATIC1111-compatible hosted API block -->
            <div data-if-conn="a1111" style="display:none;">
                <div class="if-image-row">
                    <label for="if_a1111_transport">Connect through</label>
                    <select id="if_a1111_transport" class="text_pole">
                        <option value="st-relay">SillyTavern server (recommended — no CORS needed)</option>
                        <option value="direct">Browser directly (backend must allow CORS)</option>
                    </select>
                </div>
                <div class="if-image-note">"SillyTavern server" uses the same /api/sd relay as SillyTavern's built-in Image Generation, so the backend only needs to accept the key. Enter the final https:// URL — a redirect drops the credentials.</div>
                <div class="if-image-row">
                    <label for="if_a1111_url">API base URL</label>
                    <input id="if_a1111_url" type="text" class="text_pole textarea_compact" placeholder="https://your-host.example" value="">
                </div>
                <div class="if-image-note error" id="if_a1111_url_hint" style="display:none;"></div>
                <div class="if-image-row">
                    <label for="if_a1111_auth">Authentication (as provided by the service)</label>
                    <input id="if_a1111_auth" type="password" class="text_pole textarea_compact" autocomplete="off" placeholder="user:password or the raw key string" value="">
                </div>
                <div class="if-image-row">
                    <div style="display:flex; gap:6px;">
                        <button id="if_a1111_test" class="menu_button">Test Connection</button>
                        <button id="if_a1111_models" class="menu_button">Refresh Models</button>
                    </div>
                </div>
                <div class="if-image-row">
                    <label for="if_a1111_checkpoint">Checkpoint</label>
                    <select id="if_a1111_checkpoint" class="text_pole">
                        <option value="">-- Refresh Models to load --</option>
                    </select>
                </div>
                <div class="if-image-result" id="if_a1111_result"></div>

                <!-- D9: per-checkpoint profile editor. Shown once a checkpoint
                     is selected above; nothing is stored until "Save profile". -->
                <div id="if_a1111_cp_editor" class="if-image-cp-editor" style="display:none;">
                    <h3>Checkpoint profile</h3>
                    <div class="if-image-note" id="if_cp_status"></div>
                    <div class="if-image-row">
                        <label for="if_cp_profile">Prompt style</label>
                        <select id="if_cp_profile" class="text_pole">
                            ${PROFILE_KEYS.map(k => `<option value="${k}">${PROFILES[k].label}</option>`).join('')}
                        </select>
                    </div>
                    <div class="if-image-row">
                        <label for="if_cp_size">Size</label>
                        <select id="if_cp_size" class="text_pole">
                            ${SIZE_PRESETS.map(p => `<option value="${p.key}">${p.label}</option>`).join('')}
                            <option value="custom">Custom…</option>
                        </select>
                    </div>
                    <div class="if-image-grid">
                        <div class="if-image-row">
                            <label for="if_cp_width">Width</label>
                            <input id="if_cp_width" type="number" min="256" max="2048" step="64" class="text_pole">
                        </div>
                        <div class="if-image-row">
                            <label for="if_cp_height">Height</label>
                            <input id="if_cp_height" type="number" min="256" max="2048" step="64" class="text_pole">
                        </div>
                        <div class="if-image-row">
                            <label for="if_cp_steps">Steps</label>
                            <input id="if_cp_steps" type="number" min="1" max="150" class="text_pole">
                        </div>
                        <div class="if-image-row">
                            <label for="if_cp_cfg">CFG</label>
                            <input id="if_cp_cfg" type="number" min="0" max="30" step="0.5" class="text_pole">
                        </div>
                        <div class="if-image-row">
                            <label for="if_cp_sampler">Sampler</label>
                            <select id="if_cp_sampler" class="text_pole"></select>
                        </div>
                        <div class="if-image-row">
                            <label for="if_cp_scheduler">Scheduler</label>
                            <select id="if_cp_scheduler" class="text_pole"></select>
                        </div>
                    </div>
                    <div class="if-image-row">
                        <div style="display:flex; gap:6px;">
                            <button id="if_cp_save" class="menu_button">Save profile</button>
                            <button id="if_cp_delete" class="menu_button" style="background:#552222; display:none;">Delete profile</button>
                        </div>
                    </div>
                    <div class="if-image-note">A saved profile ties this checkpoint to a prompt style and generation params. Chat markers using the checkpoint pick them up automatically (marker JSON and LLM hints still override). Without a saved profile the default profile and its Generation Params apply.</div>
                </div>
                <div id="if_a1111_cp_list" class="if-image-cp-list"></div>
            </div>
        </div>

        <!-- ============ TEST GEN TAB ============ -->
        <div class="if-image-panel" data-if-panel="test" style="display:none;">
            <div class="if-image-row">
                <label>Backend</label>
                <div class="if-image-radios">
                    <label><input type="radio" name="if_test_backend" value="comfy"> SD (A1111-compatible / Comfy proxy)</label>
                    <label><input type="radio" name="if_test_backend" value="nai"> NovelAI</label>
                </div>
            </div>

            <div class="if-image-row" data-if-comfy-only>
                <label for="if_test_profile">Profile</label>
                <select id="if_test_profile" class="text_pole">
                    ${PROFILE_KEYS.map(k => `<option value="${k}">${PROFILES[k].label}</option>`).join('')}
                </select>
            </div>

            <div class="if-image-row" data-if-sd-checkpoint style="display:none;">
                <label for="if_test_checkpoint">Checkpoint (from the backend's Refresh Models)</label>
                <select id="if_test_checkpoint" class="text_pole">
                    <option value="">-- none discovered --</option>
                </select>
            </div>

            <div class="if-image-row">
                <label for="if_test_prompt">Prompt</label>
                <textarea id="if_test_prompt" class="text_pole textarea_compact" rows="3"></textarea>
            </div>
            <div class="if-image-row" data-if-nai-only style="display:none;">
                <label for="if_test_negative">Negative</label>
                <textarea id="if_test_negative" class="text_pole textarea_compact" rows="2"></textarea>
            </div>

            <div class="if-image-grid">
                <div class="if-image-row">
                    <label for="if_test_width">Width</label>
                    <input id="if_test_width" type="number" min="64" max="4096" step="64" class="text_pole">
                </div>
                <div class="if-image-row">
                    <label for="if_test_height">Height</label>
                    <input id="if_test_height" type="number" min="64" max="4096" step="64" class="text_pole">
                </div>
                <div class="if-image-row">
                    <label for="if_test_steps">Steps</label>
                    <input id="if_test_steps" type="number" min="1" max="200" class="text_pole">
                </div>
                <div class="if-image-row">
                    <label for="if_test_cfg">CFG</label>
                    <input id="if_test_cfg" type="number" min="0" max="30" step="0.5" class="text_pole">
                </div>
                <div class="if-image-row">
                    <label for="if_test_seed">Seed (-1 random)</label>
                    <input id="if_test_seed" type="number" min="-1" class="text_pole">
                </div>
            </div>

            <div class="if-image-row">
                <div style="display:flex; gap:6px;">
                    <button id="if_test_generate" class="menu_button">Generate</button>
                    <button id="if_test_cancel" class="menu_button" style="display:none;">Cancel</button>
                </div>
            </div>

            <div class="if-image-result" id="if_test_error" style="display:none;"></div>

            <div class="if-image-output" id="if_test_output" style="display:none;">
                <img id="if_test_image" alt="Generated image"/>
                <div class="if-image-caption" id="if_test_caption"></div>
                <div class="if-image-actions">
                    <a id="if_test_download" class="menu_button" download="if-image.png">Download</a>
                    <span id="if_test_elapsed"></span>
                </div>
            </div>
        </div>

        <!-- ============ CHARACTERS TAB ============ -->
        <div class="if-image-panel" data-if-panel="chars" style="display:none;">
            <h3>Character Presets</h3>
            <div class="if-image-row" style="gap:6px; flex-wrap:wrap;">
                <button id="if_preset_export" class="menu_button">Export preset</button>
                <button id="if_preset_import" class="menu_button">Import preset</button>
                <select id="if_preset_import_mode" class="text_pole" style="width:auto;" title="Conflict handling for records that already exist (matched by id or name)">
                    <option value="keep-mine" selected>Conflicts: keep mine</option>
                    <option value="overwrite">Conflicts: overwrite</option>
                </select>
                <input id="if_preset_import_file" type="file" accept=".json,application/json" style="display:none;">
            </div>
            <div id="if_preset_status" class="if-image-result"></div>
            <div class="if-image-row">
                <label for="if_char_select">Select Character</label>
                <div style="display:flex; gap:6px;">
                    <select id="if_char_select" class="text_pole" style="flex:1;">
                        <option value="">-- New Character --</option>
                    </select>
                    <button id="if_char_new" class="menu_button">+ New</button>
                </div>
            </div>
            <div class="if-image-row">
                <label for="if_char_name">Name (Trigger: $Name)</label>
                <input id="if_char_name" type="text" class="text_pole" placeholder="e.g. Lyna">
            </div>
            <div class="if-image-row">
                <label for="if_char_aliases">Aliases (comma separated)</label>
                <input id="if_char_aliases" type="text" class="text_pole" placeholder="e.g. lyna, dark elf">
            </div>
            <div class="if-image-row">
                <label for="if_char_count">Count Tag</label>
                <input id="if_char_count" type="text" class="text_pole" value="1girl">
            </div>
            <div class="if-image-row">
                <label for="if_char_booru">Booru Tags (Illus/Anima)</label>
                <textarea id="if_char_booru" class="text_pole textarea_compact" rows="2" placeholder="silver hair, purple eyes, elf ears"></textarea>
            </div>
            <div class="if-image-row">
                <label for="if_char_natural">Natural Description (Krea)</label>
                <textarea id="if_char_natural" class="text_pole textarea_compact" rows="2" placeholder="a young elf woman with long silver hair and glowing purple eyes"></textarea>
            </div>
            <div class="if-image-row">
                <label for="if_char_facts">Neutral Facts (Core traits)</label>
                <textarea id="if_char_facts" class="text_pole textarea_compact" rows="2" placeholder="Age 24, archer, wears leather tunic"></textarea>
            </div>
            <div class="if-image-row">
                <label for="if_char_views_back">View: Back (flat fallback, used when the matrix cell below is empty)</label>
                <input id="if_char_views_back" type="text" class="text_pole" placeholder="e.g. long hair over back, viewed from behind">
            </div>
            <div class="if-image-row">
                <label for="if_char_nsfw_extra">NSFW Extra (flat fallback)</label>
                <textarea id="if_char_nsfw_extra" class="text_pole textarea_compact" rows="2"></textarea>
            </div>
            <div class="if-image-row">
                <label for="if_char_negative">Character Negative</label>
                <textarea id="if_char_negative" class="text_pole textarea_compact" rows="2" placeholder="tags to always exclude for this character"></textarea>
            </div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_char_lock_seed"> Lock seed
                </label>
                <input id="if_char_lock_seed_value" type="number" class="text_pole" style="max-width:140px;" placeholder="-1">
            </div>

            <hr class="if-image-sep"/>
            <h4>Booru Detail Matrix</h4>
            <div class="if-image-note">Per region/rating/view detail tags. An empty cell falls back to the flat fields above (back/nsfw) or is simply omitted (front/lower have no legacy equivalent).</div>
            <table class="if-image-matrix" id="if_char_matrix">
                <thead><tr><th>Region</th><th>SFW front</th><th>SFW back</th><th>NSFW front</th><th>NSFW back</th></tr></thead>
                <tbody>
                    ${['face', 'upper', 'lower'].map(region => `
                    <tr data-region="${region}">
                        <td>${region}</td>
                        <td><input type="text" class="text_pole" data-cell="sfw.front"></td>
                        <td><input type="text" class="text_pole" data-cell="sfw.back"></td>
                        <td><input type="text" class="text_pole" data-cell="nsfw.front"></td>
                        <td><input type="text" class="text_pole" data-cell="nsfw.back"></td>
                    </tr>`).join('')}
                </tbody>
            </table>

            <hr class="if-image-sep"/>
            <h4>Outfits</h4>
            <div class="if-image-note">Outfits with no character assigned ("Common") are usable by every character via the same trigger token.</div>
            <div id="if_char_outfits_list" class="if-image-log"></div>
            <div class="if-image-row">
                <input id="if_char_outfit_name" type="text" class="text_pole" placeholder="Outfit name (trigger: $Name:outfitName)">
            </div>
            <div class="if-image-row">
                <input id="if_char_outfit_tags" type="text" class="text_pole" placeholder="tags appended when this outfit is triggered">
            </div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_char_outfit_common"> Common (usable by any character)
                </label>
                <button id="if_char_outfit_add" class="menu_button">+ Add / Update Outfit</button>
            </div>

            <div style="display:flex; gap:6px; margin-top:4px;">
                <button id="if_char_save" class="menu_button" style="flex:1;">Save Character</button>
                <button id="if_char_del" class="menu_button" style="background:#552222;">Delete</button>
            </div>
            <div id="if_char_status" class="if-image-result"></div>
        </div>

        <!-- ============ PERSONA & STYLES TAB ============ -->
        <div class="if-image-panel" data-if-panel="presets" style="display:none;">
            <h3>User Persona ($me)</h3>
            <div class="if-image-row">
                <label for="if_per_select">Select Persona</label>
                <div style="display:flex; gap:6px;">
                    <select id="if_per_select" class="text_pole" style="flex:1;">
                        <option value="">-- New Persona --</option>
                    </select>
                    <button id="if_per_new" class="menu_button">+ New</button>
                    <button id="if_per_del" class="menu_button" style="background:#552222;">Delete</button>
                </div>
            </div>
            <div class="if-image-row">
                <label for="if_per_name">Persona Name</label>
                <input id="if_per_name" type="text" class="text_pole" value="Default User">
            </div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_per_default"> Default persona ($me resolves to this one)
                </label>
            </div>
            <div class="if-image-row">
                <label for="if_per_pov">Default POV Mode</label>
                <select id="if_per_pov" class="text_pole">
                    <option value="auto">Auto (Context)</option>
                    <option value="hidden">Hidden (Solo girl looking at viewer)</option>
                    <option value="hands">Hands (POV hands in frame)</option>
                    <option value="full">Full (Visible in scene)</option>
                    <option value="third_person">Third Person (No POV)</option>
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_per_booru">Persona Booru Tags</label>
                <input id="if_per_booru" type="text" class="text_pole" placeholder="1boy, black hair, casual clothes">
            </div>
            <div class="if-image-row">
                <label for="if_per_natural">Persona Natural (Krea)</label>
                <input id="if_per_natural" type="text" class="text_pole" placeholder="a young man in casual attire">
            </div>
            <div class="if-image-row">
                <label for="if_per_facts">Persona Facts</label>
                <input id="if_per_facts" type="text" class="text_pole" placeholder="core traits, dialect-free text">
            </div>
            <div class="if-image-row">
                <label for="if_per_avoid">Avoid Tags (comma separated, stripped by cleanup)</label>
                <input id="if_per_avoid" type="text" class="text_pole" placeholder="e.g. beard, glasses">
            </div>
            <div class="if-image-row">
                <button id="if_per_save" class="menu_button">Save Persona</button>
            </div>

            <hr class="if-image-sep"/>

            <h3>Style Preset</h3>
            <div class="if-image-row">
                <label for="if_style_select">Select Style</label>
                <div style="display:flex; gap:6px;">
                    <select id="if_style_select" class="text_pole" style="flex:1;">
                        <option value="">-- New Style --</option>
                    </select>
                    <button id="if_style_new" class="menu_button">+ New</button>
                    <button id="if_style_del" class="menu_button" style="background:#552222;">Delete</button>
                </div>
            </div>
            <div class="if-image-row">
                <label for="if_style_name">Style Name ({{style: Name}})</label>
                <input id="if_style_name" type="text" class="text_pole" placeholder="e.g. Cyberpunk">
            </div>
            <div class="if-image-row">
                <label for="if_style_krea">Krea: Style Phrase</label>
                <input id="if_style_krea" type="text" class="text_pole" placeholder="cyberpunk aesthetic, neon lighting, 35mm film">
            </div>
            <div class="if-image-row">
                <label for="if_style_krea_light">Krea: Lighting</label>
                <input id="if_style_krea_light" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_style_krea_cam">Krea: Camera</label>
                <input id="if_style_krea_cam" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_style_anima_tags">Anima: Booru Tags</label>
                <input id="if_style_anima_tags" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_style_anima_artists">Anima: Artists</label>
                <input id="if_style_anima_artists" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_style_illus">Illustrious: Artists / Tags</label>
                <input id="if_style_illus" type="text" class="text_pole" placeholder="retro anime, 1990s (style), neon city">
            </div>
            <div class="if-image-row">
                <label for="if_style_illus_quality">Illustrious: Quality Prefix</label>
                <input id="if_style_illus_quality" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_style_illus_neg">Illustrious: Negative Tags</label>
                <input id="if_style_illus_neg" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <button id="if_style_save" class="menu_button">Save Style</button>
            </div>
            <div id="if_presets_status" class="if-image-result"></div>
        </div>

        <!-- ============ REPLACE TAB ============ -->
        <div class="if-image-panel" data-if-panel="replace" style="display:none;">
            <h3>Replace Rules</h3>
            <div class="if-image-note">Trigger on a tag, then prefix/suffix/replace/delete it. Multi-trigger: "a|b". Condition: "@if dialect==illus", "@if nsfw", "@if !nsfw" (safe evaluator — no code execution). Pipeline order: compile &rarr; non-final rules &rarr; cleanup &rarr; final rules.</div>
            <div id="if_replace_list" class="if-image-log"></div>

            <div class="if-image-row">
                <label for="if_replace_trigger">Trigger (a|b for multiple)</label>
                <input id="if_replace_trigger" type="text" class="text_pole" placeholder="e.g. bad hands|bad fingers">
            </div>
            <div class="if-image-row">
                <label for="if_replace_mode">Mode</label>
                <select id="if_replace_mode" class="text_pole">
                    <option value="replace">replace</option>
                    <option value="prefix-head">prefix-head</option>
                    <option value="prefix-tail">prefix-tail</option>
                    <option value="suffix-head">suffix-head</option>
                    <option value="suffix-tail">suffix-tail</option>
                    <option value="delete">delete</option>
                    <option value="final">final (runs after cleanup)</option>
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_replace_replacement">Replacement</label>
                <input id="if_replace_replacement" type="text" class="text_pole" placeholder="new tag text (ignored for delete)">
            </div>
            <div class="if-image-row">
                <label for="if_replace_condition">Condition (optional)</label>
                <input id="if_replace_condition" type="text" class="text_pole" placeholder="@if dialect==illus">
            </div>
            <div class="if-image-row">
                <button id="if_replace_add" class="menu_button">+ Add Rule</button>
            </div>

            <div class="if-image-row">
                <label for="if_replace_compact">Quick add (compact syntax: "a|b=replacement", mode=replace)</label>
                <input id="if_replace_compact" type="text" class="text_pole" placeholder="bad hands|bad fingers=good hands">
            </div>
            <div class="if-image-row">
                <button id="if_replace_compact_add" class="menu_button">+ Add from compact line</button>
            </div>

            <hr class="if-image-sep"/>
            <h3>Dry-run Preview</h3>
            <div class="if-image-note">Runs the current Test Gen prompt (Test Gen tab) through compile() including these rules.</div>
            <div class="if-image-row">
                <button id="if_replace_preview" class="menu_button">Preview against Test Gen prompt</button>
            </div>
            <div id="if_replace_preview_out" class="if-image-result"></div>
        </div>

        <!-- ============ GALLERY TAB ============ -->
        <div class="if-image-panel" data-if-panel="gallery" style="display:none;">
            <h3>Gallery <span id="if_gallery_stats" class="if-image-hint"></span></h3>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="radio" name="if_gallery_scope" id="if_gallery_scope_chat" value="chat" checked> Current chat
                </label>
                <label class="if-image-check">
                    <input type="radio" name="if_gallery_scope" id="if_gallery_scope_all" value="all"> All chats
                </label>
            </div>
            <div class="if-image-row" style="gap:6px; flex-wrap:wrap;">
                <button id="if_gallery_prune_old" class="menu_button">Delete older than</button>
                <input id="if_gallery_prune_days" type="number" class="text_pole textarea_compact" min="1" step="1" value="30" style="width:64px;"> days
                <button id="if_gallery_prune_chat" class="menu_button" style="background:#552222;">Delete all in this chat</button>
            </div>
            <div class="if-image-row" style="gap:6px; flex-wrap:wrap;" title="0 disables each knob. Applied on load (TTL/size) and on new saves (JPEG).">
                <label>TTL days <input id="if_cache_ttl" type="number" class="text_pole textarea_compact" min="0" step="1" style="width:64px;"></label>
                <label>Max MB <input id="if_cache_maxmb" type="number" class="text_pole textarea_compact" min="0" step="1" style="width:64px;"></label>
                <label>JPEG quality <input id="if_cache_jpegq" type="number" class="text_pole textarea_compact" min="0" max="100" step="1" style="width:64px;"></label>
            </div>
            <div class="if-image-gallery-grid" id="if_gallery_grid"></div>
            <div class="if-image-row" style="justify-content:center; gap:8px;">
                <button id="if_gallery_prev" class="menu_button">&larr; Prev</button>
                <span id="if_gallery_page_label"></span>
                <button id="if_gallery_next" class="menu_button">Next &rarr;</button>
            </div>

            <hr class="if-image-sep"/>
            <div id="if_gallery_detail" style="display:none;">
                <h4>Image Detail</h4>
                <img id="if_gallery_detail_img" style="max-width:100%; max-height:50vh; display:block; border-radius:8px;" alt="Selected generated image"/>
                <div class="if-image-preview-field" id="if_gallery_detail_meta"></div>
                <div class="if-image-row" style="gap:6px;">
                    <a id="if_gallery_detail_download" class="menu_button" download="if-image.png">Download</a>
                    <button id="if_gallery_detail_regen" class="menu_button">Regenerate</button>
                    <button id="if_gallery_detail_repro" class="menu_button" title="Regenerate with this image's exact seed">Repro</button>
                    <button id="if_gallery_detail_delete" class="menu_button" style="background:#552222;">Delete</button>
                    <button id="if_gallery_detail_close" class="menu_button">Close</button>
                </div>
                <div class="if-image-row">
                    <label for="if_gallery_lock_char">Lock seed to character</label>
                    <div style="display:flex; gap:6px;">
                        <select id="if_gallery_lock_char" class="text_pole" style="flex:1;">
                            <option value="">-- select character --</option>
                        </select>
                        <button id="if_gallery_lock_apply" class="menu_button">Lock</button>
                    </div>
                </div>
                <div id="if_gallery_detail_status" class="if-image-result"></div>
            </div>
        </div>

        <!-- ============ 3-DIALECT PREVIEW TAB ============ -->
        <div class="if-image-panel" data-if-panel="render" style="display:none;">
            <h3>Test-Render (Offline Compiler)</h3>

            <h4>Character Picker (C9)</h4>
            <div class="if-image-note">Pick characters/persona and modifier toggles, then "Insert Tokens" to prepend the matching trigger syntax to the input below.</div>
            <div id="if_render_picker" class="if-image-log"></div>
            <div class="if-image-row">
                <button id="if_render_insert" class="menu_button">Insert Selected as Tokens</button>
                <button id="if_render_clear" class="menu_button">Clear Input</button>
            </div>

            <div class="if-image-row">
                <label for="if_render_input">Input with triggers ($Name, $me, {{style:}}, {{dialect:}})</label>
                <textarea id="if_render_input" class="text_pole textarea_compact" rows="2" placeholder="e.g. $Lyna:back sitting at a bar, neon lights, {{style: Cyberpunk}}"></textarea>
            </div>
            <div class="if-image-row">
                <button id="if_render_btn" class="menu_button">Compile Preview</button>
            </div>

            <div id="if_render_results" style="display:flex; flex-direction:column; gap:8px; margin-top:6px;">
                <div class="if-image-preview-block" data-if-dialect="krea">
                    <strong style="color:#7aa2f7;">1. Krea 2 (Prose):</strong>
                    <div class="if-image-preview-field if-render-prompt" data-dialect="krea"><span class="k">prompt:</span> (Click Compile)</div>
                    <div class="if-image-preview-field if-render-negative" data-dialect="krea"><span class="k">negative:</span></div>
                    <div class="if-image-preview-field if-render-params" data-dialect="krea"><span class="k">params:</span></div>
                </div>
                <div class="if-image-preview-block" data-if-dialect="anima">
                    <strong style="color:#bb9af7;">2. rdbt Anima (Hybrid):</strong>
                    <div class="if-image-preview-field if-render-prompt" data-dialect="anima"><span class="k">prompt:</span> (Click Compile)</div>
                    <div class="if-image-preview-field if-render-negative" data-dialect="anima"><span class="k">negative:</span></div>
                    <div class="if-image-preview-field if-render-params" data-dialect="anima"><span class="k">params:</span></div>
                </div>
                <div class="if-image-preview-block" data-if-dialect="illus">
                    <strong style="color:#7dcfff;">3. Illustrious (Booru):</strong>
                    <div class="if-image-preview-field if-render-prompt" data-dialect="illus"><span class="k">prompt:</span> (Click Compile)</div>
                    <div class="if-image-preview-field if-render-negative" data-dialect="illus"><span class="k">negative:</span></div>
                    <div class="if-image-preview-field if-render-params" data-dialect="illus"><span class="k">params:</span></div>
                </div>
            </div>
        </div>
    </div>`;

    const root = document.createElement('div');
    root.innerHTML = html;
    const el = root.firstElementChild;

    // Element helpers
    const $ = id => el.querySelector('#' + id);

    // Log/prompt/name text is user- or LLM-controlled: always escape before
    // interpolating into innerHTML.
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ================= Tabs Switching =================
    el.querySelectorAll('.if-image-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            el.querySelectorAll('.if-image-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            el.querySelectorAll('.if-image-panel').forEach(p => {
                p.style.display = p.dataset.ifPanel === btn.dataset.ifTab ? '' : 'none';
            });
        });
    });

    // ================= Main Tab Wiring =================
    const mainEnabled = $('if_main_enabled');
    const mainGenEnabled = $('if_main_gen_enabled');
    const mainStart = $('if_main_start');
    const mainEnd = $('if_main_end');
    const mainBackend = $('if_main_backend');
    const mainProfile = $('if_main_profile');
    const mainCheckpoint = $('if_main_checkpoint');
    const mainMode = $('if_main_mode');

    mainEnabled.checked = settings.enabled !== false;
    mainGenEnabled.checked = settings.generation.enabled !== false;
    mainStart.value = settings.generation.startTag || 'image###';
    mainEnd.value = settings.generation.endTag || '###';
    mainBackend.value = settings.generation.backend || 'comfy';
    mainProfile.value = settings.generation.profile || settings.backends.comfy.profile || 'anima';
    mainMode.value = settings.generation.mode || 'direct';

    mainEnabled.addEventListener('change', () => { settings.enabled = mainEnabled.checked; save(); });
    mainGenEnabled.addEventListener('change', () => { settings.generation.enabled = mainGenEnabled.checked; save(); });
    mainStart.addEventListener('change', () => {
        const value = mainStart.value.trim();
        if (!value) {
            mainStart.value = settings.generation.startTag || 'image###';
            mainStart.setCustomValidity('Start tag cannot be empty.');
            mainStart.reportValidity();
            return;
        }
        mainStart.setCustomValidity('');
        settings.generation.startTag = value;
        save();
    });
    mainEnd.addEventListener('change', () => {
        const value = mainEnd.value.trim();
        if (!value) {
            mainEnd.value = settings.generation.endTag || '###';
            mainEnd.setCustomValidity('End tag cannot be empty.');
            mainEnd.reportValidity();
            return;
        }
        mainEnd.setCustomValidity('');
        settings.generation.endTag = value;
        save();
    });
    mainBackend.addEventListener('change', () => { settings.generation.backend = mainBackend.value; save(); });
    mainProfile.addEventListener('change', () => { settings.generation.profile = mainProfile.value; save(); });
    // R4: default checkpoint for marker generation (generation.checkpoint).
    // Options are (re)built by syncMainCheckpoint() from persisted discovery.
    mainCheckpoint.addEventListener('change', () => { settings.generation.checkpoint = mainCheckpoint.value; save(); });
    mainMode.addEventListener('change', () => { settings.generation.mode = mainMode.value; save(); });

    // ================= Backends Tab Wiring =================
    const naiKey = $('if_nai_key');
    const naiModel = $('if_nai_model');
    const naiTest = $('if_nai_test');
    const naiResult = $('if_nai_result');
    const sdConnection = $('if_sd_connection');
    const comfyBlock = el.querySelector('[data-if-conn="legacy_proxy"]');
    const a1111Block = el.querySelector('[data-if-conn="a1111"]');
    const comfyUrl = $('if_comfy_url');
    const comfyUser = $('if_comfy_user');
    const comfyPass = $('if_comfy_pass');
    const comfyProfile = $('if_comfy_profile');
    const comfyTest = $('if_comfy_test');
    const comfyModelsBtn = $('if_comfy_models');
    const comfyCheckpoint = $('if_comfy_checkpoint');
    const comfyResult = $('if_comfy_result');
    const a1111Url = $('if_a1111_url');
    const a1111Auth = $('if_a1111_auth');
    const a1111Test = $('if_a1111_test');
    const a1111ModelsBtn = $('if_a1111_models');
    const a1111Checkpoint = $('if_a1111_checkpoint');
    const a1111Result = $('if_a1111_result');

    naiKey.value = settings.backends.nai.apiKey;
    naiModel.value = settings.backends.nai.model;
    // D5: Variety+ toggle (migrator v7 default: false).
    const naiVariety = $('if_nai_variety');
    if (naiVariety) {
        naiVariety.checked = settings.backends.nai.variety === true;
        naiVariety.addEventListener('change', () => {
            settings.backends.nai.variety = naiVariety.checked;
            save();
        });
    }
    comfyUrl.value = settings.backends.comfy.baseUrl;
    comfyUser.value = settings.backends.comfy.username;
    comfyPass.value = settings.backends.comfy.password;
    comfyProfile.value = settings.backends.comfy.profile;
    a1111Url.value = settings.backends.a1111.baseUrl;
    a1111Auth.value = settings.backends.a1111.auth;

    naiKey.addEventListener('change', () => { settings.backends.nai.apiKey = naiKey.value.trim(); save(); });
    naiModel.addEventListener('change', () => { settings.backends.nai.model = naiModel.value; save(); });
    comfyUrl.addEventListener('change', () => {
        settings.backends.comfy.baseUrl = comfyUrl.value.trim();
        // New endpoint: previously discovered models are no longer known to
        // belong to this server. Invalidate + abort in-flight discovery.
        invalidateComfyDiscovery('Base URL changed — model list invalidated. Click Refresh Models.');
        save();
        syncTestGenVisibility();
    });
    comfyUser.addEventListener('change', () => {
        settings.backends.comfy.username = comfyUser.value;
        invalidateComfyDiscovery('Credentials changed — model list invalidated. Click Refresh Models.');
        save();
        syncTestGenVisibility();
    });
    comfyPass.addEventListener('change', () => {
        settings.backends.comfy.password = comfyPass.value;
        invalidateComfyDiscovery('Credentials changed — model list invalidated. Click Refresh Models.');
        save();
        syncTestGenVisibility();
    });
    comfyProfile.addEventListener('change', () => { settings.backends.comfy.profile = comfyProfile.value; save(); });
    // The Authentication string is kept exactly as typed: no trim, no colon
    // insertion (ST getBasicAuthHeader encodes the raw string). Any URL or
    // auth change invalidates the discovered checkpoint list: a stale list
    // from the old endpoint must never drive generation on the new one.
    // Transport (st-relay | direct). Changing it does not change the endpoint
    // or the credentials, so the persisted discovery stays valid; only
    // in-flight requests are dropped.
    const a1111Transport = $('if_a1111_transport');
    const a1111UrlHint = $('if_a1111_url_hint');
    function syncA1111UrlHint() {
        if (!a1111UrlHint) return;
        const url = settings.backends.a1111.baseUrl || '';
        const relay = settings.backends.a1111.transport !== 'direct';
        const plainHttp = /^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
        if (plainHttp) {
            a1111UrlHint.textContent = relay
                ? 'This URL is http://. If the service redirects to https, the SillyTavern relay drops the credentials and the request fails with HTTP 500 — enter the https:// URL directly.'
                : 'This URL is http://. If the service redirects to https, the browser blocks the redirected request — enter the https:// URL directly.';
            a1111UrlHint.style.display = '';
        } else {
            a1111UrlHint.textContent = '';
            a1111UrlHint.style.display = 'none';
        }
    }
    if (a1111Transport) {
        a1111Transport.value = settings.backends.a1111.transport === 'direct' ? 'direct' : 'st-relay';
        a1111Transport.addEventListener('change', () => {
            settings.backends.a1111.transport = a1111Transport.value === 'direct' ? 'direct' : 'st-relay';
            invalidateA1111Discovery('Connection path changed — click Test Connection to verify.', { clearPersisted: false });
            save();
            syncA1111UrlHint();
        });
    }
    a1111Url.addEventListener('change', () => {
        settings.backends.a1111.baseUrl = a1111Url.value.trim();
        invalidateA1111Discovery('Base URL changed — model list invalidated. Click Refresh Models.');
        save();
        syncA1111UrlHint();
        syncTestGenVisibility();
    });
    syncA1111UrlHint();
    a1111Auth.addEventListener('change', () => {
        settings.backends.a1111.auth = a1111Auth.value;
        invalidateA1111Discovery('Authentication changed — model list invalidated. Click Refresh Models.');
        save();
        syncTestGenVisibility();
    });

    function showResult(node, text, isError) {
        node.textContent = text;
        node.classList.toggle('error', Boolean(isError));
    }

    naiTest.addEventListener('click', async () => {
        naiTest.disabled = true;
        naiResult.textContent = 'Checking...';
        naiResult.classList.remove('error');
        try {
            const info = await nai.ping();
            showResult(naiResult, `Tier: ${info.tier} · active: ${info.active ? 'yes' : 'no'} · Anlas: ${info.anlas}`, false);
        } catch (error) {
            showResult(naiResult, error.message, true);
        } finally {
            naiTest.disabled = false;
        }
    });

    // ---- Connection-source switching -------------------------------------
    // Discovered model lists and in-flight requests are per-source: switching
    // clears the other source's UI state so stale models/checkpoints can
    // never leak into the new configuration.
    let comfyModels = [];
    // R4: seed the A1111 model list from the last persisted discovery
    // (settings.backends.a1111.discovery, migrator v6) so selects are usable
    // right after a reload without hitting the server. Generation still
    // re-validates against fresh /sdapi/v1/sd-models in the executor.
    /** In-memory model list shape from the persisted discovery cache. */
    function a1111ModelsFromPersisted() {
        const models = settings.backends.a1111.discovery?.models;
        return Array.isArray(models)
            ? models.map(m => ({ title: m.title, model_name: m.modelName ?? m.title, filename: null }))
            : [];
    }
    let a1111Models = a1111ModelsFromPersisted();

    // Epoch guards: bumping invalidates every in-flight discovery request,
    // so a late response from an old source/URL/auth can never populate the
    // UI of the current configuration. The browser request itself is also
    // aborted where a signal was passed.
    let comfyDiscoveryEpoch = 0;
    let a1111DiscoveryEpoch = 0;
    let comfyDiscoveryController = null;
    let a1111DiscoveryController = null;

    function invalidateComfyDiscovery(reason) {
        comfyDiscoveryEpoch += 1;
        comfyDiscoveryController?.abort();
        comfyDiscoveryController = null;
        comfyModels = [];
        fillCheckpointSelect(comfyCheckpoint, [], '', '-- Refresh Models to load --');
        if (reason) showResult(comfyResult, reason, false);
        abortInFlightGeneration('Proxy URL or credentials changed — generation aborted (browser request only; a started proxy job may still finish).');
    }

    /**
     * @param {string} reason
     * @param {{clearPersisted?: boolean}} [opts] clearPersisted=true (URL/auth
     *   change): the stored discovery belongs to the old endpoint — wipe it.
     *   false (connection-source switch): keep it; only in-flight requests and
     *   the in-memory list are invalidated. checkpointProfiles are user data
     *   keyed by title and are NEVER cleared here; re-discovery only ADDs
     *   missing titles (seed semantics).
     */
    function invalidateA1111Discovery(reason, { clearPersisted = true } = {}) {
        a1111DiscoveryEpoch += 1;
        a1111DiscoveryController?.abort();
        a1111DiscoveryController = null;
        if (clearPersisted) {
            a1111Models = [];
            settings.backends.a1111.discovery = { at: 0, models: [], samplers: [], schedulers: [] };
            syncMainCheckpoint();
            fillCheckpointSelect(a1111Checkpoint, [], '', '-- Refresh Models to load --');
            syncCheckpointProfileEditor();
        } else {
            // Source switch: the persisted cache is still valid for this
            // URL/auth, so the in-memory list is re-seeded from it (same as
            // on load) instead of forcing another Refresh Models click.
            a1111Models = a1111ModelsFromPersisted();
            fillCheckpointSelect(a1111Checkpoint, a1111Models, settings.backends.a1111.checkpoint,
                a1111Models.length ? '-- select a checkpoint --' : '-- Refresh Models to load --');
        }
        if (reason) showResult(a1111Result, reason, false);
        abortInFlightGeneration('A1111 base URL or Authentication changed — generation aborted (browser request only; a started server job may still finish).');
    }

    function fillCheckpointSelect(select, models, selectedTitle, emptyLabel) {
        // R4: titles come from a remote server — escape before innerHTML.
        select.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>` +
            models.map(m => `<option value="${escapeHtml(m.title)}">${escapeHtml(m.title)}</option>`).join('');
        select.value = models.some(m => m.title === selectedTitle) ? selectedTitle : '';
    }

    function syncConnectionBlocks() {
        const conn = settings.backends.comfy.connection === 'a1111' ? 'a1111' : 'legacy_proxy';
        comfyBlock.style.display = conn === 'legacy_proxy' ? '' : 'none';
        a1111Block.style.display = conn === 'a1111' ? '' : 'none';
    }

    sdConnection.addEventListener('change', () => {
        settings.backends.comfy.connection = sdConnection.value;
        // Invalidate the OTHER source's discovered state; its stored
        // checkpoint stays in settings but must be re-discovered. In-flight
        // discovery from either source is aborted + epoch-bumped so results
        // from the old source can never land in the new configuration.
        if (sdConnection.value === 'a1111') {
            invalidateComfyDiscovery('');
        } else {
            // Source switch only: URL/auth unchanged, so the persisted
            // discovery stays valid for when the user switches back.
            invalidateA1111Discovery('', { clearPersisted: false });
        }
        // A generation running against the previous source must not land
        // here either: abort it (browser request only).
        abortInFlightGeneration('Connection source changed — generation aborted (browser request only; a started server job may still finish).');
        showResult(comfyResult, '', false);
        showResult(a1111Result, '', false);
        save();
        syncConnectionBlocks();
        syncTestGenVisibility();
    });
    sdConnection.value = settings.backends.comfy.connection === 'a1111' ? 'a1111' : 'legacy_proxy';
    syncConnectionBlocks();

    // ---- Legacy proxy: test + refresh models + checkpoint ----------------
    comfyTest.addEventListener('click', async () => {
        comfyTest.disabled = true;
        comfyResult.textContent = 'Checking...';
        comfyResult.classList.remove('error');
        try {
            const ping = await comfy.ping();
            showResult(comfyResult, `Proxy OK (${ping.service ?? 'ready'})`, false);
        } catch (error) {
            showResult(comfyResult, error.message, true);
        } finally {
            comfyTest.disabled = false;
        }
    });

    // Abort any in-flight test generation: its result belongs to a
    // configuration that is about to change (source/URL/auth). Only the
    // browser request is aborted — the server/proxy may still finish the job.
    function abortInFlightGeneration(reason) {
        if (generateController) {
            generateController.abort();
            errorBox.textContent = reason;
            errorBox.style.display = '';
        }
    }

    comfyModelsBtn.addEventListener('click', async () => {
        comfyModelsBtn.disabled = true;
        comfyResult.textContent = 'Loading models...';
        comfyResult.classList.remove('error');
        // New epoch for this click; any older in-flight request is dead.
        comfyDiscoveryEpoch += 1;
        const epoch = comfyDiscoveryEpoch;
        comfyDiscoveryController = new AbortController();
        try {
            const list = await comfy.models({ signal: comfyDiscoveryController.signal });
            if (epoch !== comfyDiscoveryEpoch) return; // stale: source/URL/auth changed meanwhile
            comfyModels = Array.isArray(list)
                ? list.map(m => ({ title: m.title ?? m.model_name, model_name: m.model_name }))
                : [];
            fillCheckpointSelect(comfyCheckpoint, comfyModels, settings.backends.comfy.proxyModel ?? '', '-- select a model --');
            comfyCheckpoint.value = comfyModels.some(m => m.title === settings.backends.comfy.proxyModel) ? settings.backends.comfy.proxyModel : '';
            showResult(comfyResult, `${comfyModels.length} model(s) available.`, false);
            syncTestGenVisibility();
        } catch (error) {
            if (epoch !== comfyDiscoveryEpoch) return; // stale error: swallow
            comfyModels = [];
            fillCheckpointSelect(comfyCheckpoint, [], '', '-- Refresh Models to load --');
            showResult(comfyResult, error.message, true);
            syncTestGenVisibility();
        } finally {
            if (epoch === comfyDiscoveryEpoch) {
                comfyDiscoveryController = null;
                comfyModelsBtn.disabled = false;
            }
        }
    });

    comfyCheckpoint.addEventListener('change', () => {
        settings.backends.comfy.proxyModel = comfyCheckpoint.value;
        save();
        syncTestGenVisibility();
    });

    // ---- A1111: test + refresh models + checkpoint ------------------------
    // R4/D9: both buttons run the composite discover() (models required;
    // samplers/schedulers/-/internal/models optional) and persist the result
    // in settings.backends.a1111.discovery with a timestamp. Discovery never
    // writes checkpointProfiles — rows come only from "Save profile".
    function persistA1111Discovery(discovery) {
        settings.backends.a1111.discovery = {
            at: Date.now(),
            models: discovery.models,
            samplers: discovery.samplers,
            schedulers: discovery.schedulers,
        };
        a1111Models = discovery.models.map(m => ({ title: m.title, model_name: m.modelName ?? m.title, filename: null }));
        fillCheckpointSelect(a1111Checkpoint, a1111Models, settings.backends.a1111.checkpoint, '-- select a checkpoint --');
        if (!resolveCheckpoint(a1111Models, settings.backends.a1111.checkpoint)) {
            settings.backends.a1111.checkpoint = '';
            a1111Checkpoint.value = '';
        }
        save();
        syncMainCheckpoint();
        syncCheckpointProfileEditor();
        syncTestGenVisibility();
    }

    a1111Test.addEventListener('click', async () => {
        a1111Test.disabled = true;
        a1111Result.textContent = 'Testing (GET options + discovery; nothing is written to the server)...';
        a1111Result.classList.remove('error');
        a1111DiscoveryEpoch += 1;
        const epoch = a1111DiscoveryEpoch;
        a1111DiscoveryController = new AbortController();
        try {
            const signal = a1111DiscoveryController.signal;
            const options = await a1111.options({ signal }); // auth/connectivity check
            const discovery = await a1111.discover({ signal });
            if (epoch !== a1111DiscoveryEpoch) return; // stale: URL/auth/source changed meanwhile
            persistA1111Discovery(discovery);
            const current = typeof options.sd_model_checkpoint === 'string' && options.sd_model_checkpoint
                ? options.sd_model_checkpoint : '(none reported)';
            const parts = [`Connected. ${discovery.models.length} checkpoint(s).`];
            parts.push(`Server default: ${current}`);
            parts.push(`${discovery.samplers.length} sampler(s), ${discovery.schedulers.length} scheduler(s).`);
            if (discovery.enrichment === 'internal') parts.push('Enriched via /internal/models.');
            showResult(a1111Result, parts.join(' · '), false);
        } catch (error) {
            if (epoch !== a1111DiscoveryEpoch) return; // stale error: swallow
            showResult(a1111Result, error.message, true);
            syncTestGenVisibility();
        } finally {
            if (epoch === a1111DiscoveryEpoch) {
                a1111DiscoveryController = null;
                a1111Test.disabled = false;
            }
        }
    });

    a1111ModelsBtn.addEventListener('click', async () => {
        a1111ModelsBtn.disabled = true;
        a1111Result.textContent = 'Loading models...';
        a1111Result.classList.remove('error');
        a1111DiscoveryEpoch += 1;
        const epoch = a1111DiscoveryEpoch;
        a1111DiscoveryController = new AbortController();
        try {
            const discovery = await a1111.discover({ signal: a1111DiscoveryController.signal });
            if (epoch !== a1111DiscoveryEpoch) return; // stale: URL/auth/source changed meanwhile
            persistA1111Discovery(discovery);
            showResult(a1111Result, `${discovery.models.length} checkpoint(s), ${discovery.samplers.length} sampler(s), ${discovery.schedulers.length} scheduler(s).`, false);
        } catch (error) {
            if (epoch !== a1111DiscoveryEpoch) return; // stale error: swallow
            a1111Models = [];
            fillCheckpointSelect(a1111Checkpoint, [], '', '-- Refresh Models to load --');
            showResult(a1111Result, error.message, true);
            syncTestGenVisibility();
        } finally {
            if (epoch === a1111DiscoveryEpoch) {
                a1111DiscoveryController = null;
                a1111ModelsBtn.disabled = false;
            }
        }
    });

    a1111Checkpoint.addEventListener('change', () => {
        settings.backends.a1111.checkpoint = a1111Checkpoint.value;
        save();
        syncCheckpointProfileEditor();
        syncTestGenVisibility();
    });

    // ---- R4: Main-tab checkpoint select (generation.checkpoint) -----------
    // Options come from the PERSISTED discovery so they survive reloads. A
    // stored title missing from the list stays selectable but is labeled
    // "(not discovered)" — the executor re-validates at generation time.
    function syncMainCheckpoint() {
        const models = settings.backends.a1111.discovery?.models ?? [];
        const stored = settings.generation.checkpoint || '';
        const missing = stored && !models.some(m => m.title === stored);
        mainCheckpoint.innerHTML = '<option value="">-- none selected --</option>'
            + models.map(m => `<option value="${escapeHtml(m.title)}">${escapeHtml(m.title)}</option>`).join('')
            + (missing ? `<option value="${escapeHtml(stored)}">${escapeHtml(stored)} (not discovered)</option>` : '');
        mainCheckpoint.value = stored;
    }
    syncMainCheckpoint();
    // Seed the Backends checkpoint select from the persisted discovery too.
    if (a1111Models.length) {
        fillCheckpointSelect(a1111Checkpoint, a1111Models, settings.backends.a1111.checkpoint, '-- select a checkpoint --');
    }

    // ---- D9: per-checkpoint profile editor ---------------------------------
    // Shown for the checkpoint selected in the A1111 block. The form starts
    // from the saved row when one exists, otherwise from a suggestion
    // (server per-model defaults when /internal/models enrichment ran, else
    // the inferred prompt profile's numbers). Nothing is persisted until
    // "Save profile"; rows are keyed by checkpoint title and used by
    // compile()/mergeParams exactly as before.
    const cpEditor = $('if_a1111_cp_editor');
    const cpStatus = $('if_cp_status');
    const cpProfile = $('if_cp_profile');
    const cpSize = $('if_cp_size');
    const cpWidth = $('if_cp_width');
    const cpHeight = $('if_cp_height');
    const cpSteps = $('if_cp_steps');
    const cpCfg = $('if_cp_cfg');
    const cpSampler = $('if_cp_sampler');
    const cpScheduler = $('if_cp_scheduler');
    const cpSave = $('if_cp_save');
    const cpDelete = $('if_cp_delete');
    const cpList = $('if_a1111_cp_list');

    function cpOptionList(values, selected) {
        const list = Array.isArray(values) ? values.filter(v => typeof v === 'string' && v) : [];
        const missing = selected && !list.includes(selected);
        return '<option value="">(server default)</option>'
            + list.map(v => `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('')
            + (missing ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (not discovered)</option>` : '');
    }

    /** Fill the editor form from a row-shaped object. */
    function cpFillForm(values) {
        if (!cpEditor) return;
        cpProfile.value = PROFILES[values.profile] ? values.profile : PROFILE_KEYS[0];
        cpWidth.value = values.width ?? '';
        cpHeight.value = values.height ?? '';
        cpSteps.value = values.steps ?? '';
        cpCfg.value = values.cfg ?? '';
        const disc = settings.backends.a1111.discovery ?? {};
        cpSampler.innerHTML = cpOptionList(disc.samplers, values.sampler ?? '');
        cpScheduler.innerHTML = cpOptionList(disc.schedulers, values.scheduler ?? '');
        cpSyncSizePreset();
    }

    /** Keep the size preset select in step with the numeric fields. */
    function cpSyncSizePreset() {
        if (!cpSize) return;
        cpSize.value = matchSizePreset(cpWidth.value, cpHeight.value);
    }

    /** Re-render editor + saved-profile list for the current checkpoint. */
    function syncCheckpointProfileEditor() {
        if (!cpEditor) return;
        const title = settings.backends.a1111.checkpoint || '';
        const profiles = settings.backends.a1111.checkpointProfiles ?? {};
        if (!title) {
            cpEditor.style.display = 'none';
        } else {
            cpEditor.style.display = '';
            const saved = profiles[title];
            if (saved && typeof saved === 'object' && PROFILES[saved.profile]) {
                cpFillForm(saved);
                cpStatus.textContent = `Saved profile for "${title}".`;
                cpDelete.style.display = '';
            } else {
                const disc = settings.backends.a1111.discovery ?? {};
                const model = (disc.models ?? []).find(m => m?.title === title) ?? { title };
                const fallbackKey = settings.generation.profile || settings.backends.comfy.profile || 'anima';
                const suggestion = suggestCheckpointProfile(model, fallbackKey, { samplers: disc.samplers, schedulers: disc.schedulers });
                cpFillForm(suggestion);
                cpStatus.textContent = suggestion.source === 'server'
                    ? `No profile saved for "${title}" yet — values below are the server's suggestion for this checkpoint.`
                    : `No profile saved for "${title}" yet — values below come from the ${PROFILES[suggestion.profile].label} defaults.`;
                cpDelete.style.display = 'none';
            }
        }
        renderCheckpointProfileList();
    }

    /** Compact list of every saved profile with a "use" + "delete" action. */
    function renderCheckpointProfileList() {
        if (!cpList) return;
        const profiles = settings.backends.a1111.checkpointProfiles ?? {};
        const titles = Object.keys(profiles).filter(t => profiles[t] && typeof profiles[t] === 'object');
        if (!titles.length) {
            cpList.innerHTML = '';
            return;
        }
        const discovered = new Set((settings.backends.a1111.discovery?.models ?? []).map(m => m?.title).filter(Boolean));
        cpList.innerHTML = '<h3>Saved checkpoint profiles</h3>' + titles.map((title, i) => {
            const e = profiles[title];
            const style = PROFILES[e.profile]?.label ?? e.profile;
            const size = e.width && e.height ? `${e.width}×${e.height}` : 'size: inherit';
            const bits = [style, size];
            if (e.steps !== undefined) bits.push(`${e.steps} steps`);
            if (e.cfg !== undefined) bits.push(`cfg ${e.cfg}`);
            if (e.sampler) bits.push(e.sampler);
            if (e.scheduler) bits.push(e.scheduler);
            const stale = discovered.size > 0 && !discovered.has(title);
            const active = title === settings.backends.a1111.checkpoint;
            return `<div class="if-image-cp-item${active ? ' active' : ''}" data-cp-item="${i}">
                <div class="if-image-cp-item-main">
                    <div class="if-image-cp-item-title">${escapeHtml(title)}${stale ? ' <span class="if-image-cp-badge">not on server</span>' : ''}</div>
                    <div class="if-image-cp-item-sub">${escapeHtml(bits.join(' · '))}</div>
                </div>
                <div class="if-image-cp-item-actions">
                    ${stale ? '' : '<button data-cp-use class="menu_button" title="Select this checkpoint">Use</button>'}
                    <button data-cp-del class="menu_button" title="Delete this profile">Delete</button>
                </div>
            </div>`;
        }).join('');
        cpList.querySelectorAll('[data-cp-item]').forEach(item => {
            const title = titles[Number(item.dataset.cpItem)];
            item.querySelector('[data-cp-use]')?.addEventListener('click', () => {
                settings.backends.a1111.checkpoint = title;
                a1111Checkpoint.value = title;
                save();
                syncCheckpointProfileEditor();
                syncTestGenVisibility();
            });
            item.querySelector('[data-cp-del]')?.addEventListener('click', () => deleteCheckpointProfile(title));
        });
    }

    function deleteCheckpointProfile(title) {
        delete settings.backends.a1111.checkpointProfiles[title];
        save();
        syncCheckpointProfileEditor();
    }

    if (cpEditor) {
        cpSize.addEventListener('change', () => {
            const preset = SIZE_PRESETS.find(p => p.key === cpSize.value);
            if (!preset) return; // custom: leave the numbers alone
            cpWidth.value = preset.width;
            cpHeight.value = preset.height;
        });
        cpWidth.addEventListener('input', cpSyncSizePreset);
        cpHeight.addEventListener('input', cpSyncSizePreset);
        cpSave.addEventListener('click', () => {
            const title = settings.backends.a1111.checkpoint || '';
            if (!title) return;
            const row = normalizeCheckpointProfile({
                profile: cpProfile.value,
                width: cpWidth.value,
                height: cpHeight.value,
                steps: cpSteps.value,
                cfg: cpCfg.value,
                sampler: cpSampler.value,
                scheduler: cpScheduler.value,
            });
            if (!row) {
                showResult(a1111Result, 'Pick a prompt style before saving the profile.', true);
                return;
            }
            if (!settings.backends.a1111.checkpointProfiles || typeof settings.backends.a1111.checkpointProfiles !== 'object') {
                settings.backends.a1111.checkpointProfiles = {};
            }
            settings.backends.a1111.checkpointProfiles[title] = row;
            save();
            syncCheckpointProfileEditor();
            showResult(a1111Result, `Profile saved for "${title}".`, false);
        });
        cpDelete.addEventListener('click', () => {
            const title = settings.backends.a1111.checkpoint || '';
            if (title) deleteCheckpointProfile(title);
        });
    }
    syncCheckpointProfileEditor();

    // ================= Test Gen Tab Wiring =================
    const testProfileRow = el.querySelector('[data-if-comfy-only]');
    const testNegativeRow = el.querySelector('[data-if-nai-only]');
    const testCheckpointRow = el.querySelector('[data-if-sd-checkpoint]');
    const testProfile = $('if_test_profile');
    const testCheckpoint = $('if_test_checkpoint');
    const testPrompt = $('if_test_prompt');
    const testNegative = $('if_test_negative');
    const testWidth = $('if_test_width');
    const testHeight = $('if_test_height');
    const testSteps = $('if_test_steps');
    const testCfg = $('if_test_cfg');
    const testSeed = $('if_test_seed');
    const generateBtn = $('if_test_generate');
    const cancelBtn = $('if_test_cancel');
    const errorBox = $('if_test_error');
    const outputBox = $('if_test_output');
    const imageEl = $('if_test_image');
    const captionEl = $('if_test_caption');
    const downloadEl = $('if_test_download');
    const elapsedEl = $('if_test_elapsed');

    testProfile.value = settings.test.profile || settings.backends.comfy.profile;
    testPrompt.value = settings.test.prompt;
    testNegative.value = settings.test.negative;
    testWidth.value = settings.test.width;
    testHeight.value = settings.test.height;
    testSteps.value = settings.test.steps;
    testCfg.value = settings.test.cfg;
    testSeed.value = settings.test.seed;

    function currentSdConnection() {
        return settings.backends.comfy.connection === 'a1111' ? 'a1111' : 'legacy_proxy';
    }

    /** Active discovered checkpoint for the active SD connection. */
    function activeCheckpointOptions() {
        return currentSdConnection() === 'a1111'
            ? { models: a1111Models, stored: settings.backends.a1111.checkpoint }
            : { models: comfyModels, stored: settings.backends.comfy.proxyModel ?? '' };
    }

    // Pure refresh of the Test-tab checkpoint selector from the active
    // source's discovered list + stored value. Stale selections from the
    // other source are never shown.
    function syncTestCheckpoint() {
        const { models, stored } = activeCheckpointOptions();
        const resolved = resolveCheckpoint(models, stored);
        testCheckpoint.innerHTML = models.length
            ? models.map(m => `<option value="${escapeHtml(m.title)}">${escapeHtml(m.title)}</option>`).join('')
            : '<option value="">-- none discovered (Backends → Refresh Models) --</option>';
        testCheckpoint.value = resolved ?? '';
    }

    function syncBackendRadio() {
        el.querySelectorAll('input[name="if_test_backend"]').forEach(r => {
            r.checked = r.value === settings.test.backend;
        });
        const isComfy = settings.test.backend === 'comfy';
        testProfileRow.style.display = isComfy ? '' : 'none';
        const profile = PROFILES[settings.test.profile ?? settings.backends.comfy.profile];
        testNegativeRow.style.display = (isComfy && profile?.negativeDisabled) ? 'none' : '';
        testCheckpointRow.style.display = isComfy ? '' : 'none';
        syncTestCheckpoint();
    }

    function syncTestGenVisibility() {
        syncTestCheckpoint();
    }
    syncBackendRadio();

    el.querySelectorAll('input[name="if_test_backend"]').forEach(radio => {
        radio.addEventListener('change', () => {
            settings.test.backend = radio.value;
            save();
            syncBackendRadio();
        });
    });

    testProfile.addEventListener('change', () => {
        settings.test.profile = testProfile.value;
        applyProfile(settings.test, testProfile.value, true);
        testPrompt.value = settings.test.prompt;
        testNegative.value = settings.test.negative;
        testWidth.value = settings.test.width;
        testHeight.value = settings.test.height;
        testSteps.value = settings.test.steps;
        testCfg.value = settings.test.cfg;
        testSeed.value = settings.test.seed;
        syncBackendRadio();
        save();
    });

    testCheckpoint.addEventListener('change', () => {
        if (currentSdConnection() === 'a1111') {
            settings.backends.a1111.checkpoint = testCheckpoint.value;
            // R2: prefill W/H/steps/cfg from the checkpoint's effective
            // params (PROFILES < settings params < checkpoint profile).
            // The user can still edit any field before Generate.
            const title = testCheckpoint.value;
            const cp = title ? resolveCheckpointProfile(settings, title) : null;
            if (cp) {
                const merged = mergeParams({ profileKey: cp.profileKey, checkpointTitle: title, settings });
                settings.test.width = merged.width;
                settings.test.height = merged.height;
                settings.test.steps = merged.steps;
                settings.test.cfg = merged.cfg;
                settings.test.profile = cp.profileKey;
                testWidth.value = merged.width;
                testHeight.value = merged.height;
                testSteps.value = merged.steps;
                testCfg.value = merged.cfg;
                testProfile.value = cp.profileKey;
                // The profile changed under the Test tab: re-sync dependent
                // rows (Negative is hidden for negativeDisabled profiles).
                syncBackendRadio();
            }
        } else {
            settings.backends.comfy.proxyModel = testCheckpoint.value;
        }
        save();
    });

    const bindInput = (input, apply) => {
        input.addEventListener('input', () => { apply(input.value); save(); });
    };
    bindInput(testPrompt, v => settings.test.prompt = v);
    bindInput(testNegative, v => settings.test.negative = v);
    bindInput(testWidth, v => settings.test.width = Number(v) || 832);
    bindInput(testHeight, v => settings.test.height = Number(v) || 1216);
    bindInput(testSteps, v => settings.test.steps = Number(v) || 16);
    bindInput(testCfg, v => settings.test.cfg = Number(v) || 4);
    bindInput(testSeed, v => settings.test.seed = Number.isFinite(Number(v)) ? Number(v) : -1);

    // Object URL hygiene: revoke the previous URL before showing a new one.
    let currentObjectUrl = null;
    function showImage(dataUrl) {
        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = null;
        }
        if (dataUrl.startsWith('blob:')) currentObjectUrl = dataUrl;
        imageEl.src = dataUrl;
        downloadEl.href = dataUrl;
        outputBox.style.display = '';
    }
    function disposeImage() {
        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = null;
        }
        imageEl.removeAttribute('src');
    }

    // Cancellation: aborts the browser request only. The server job (if any)
    // is NOT cancelled — /sdapi/v1/interrupt is never called because a hosted
    // instance may be shared with other users.
    let generateController = null;
    cancelBtn.addEventListener('click', () => {
        if (generateController) generateController.abort();
    });

    generateBtn.addEventListener('click', async () => {
        if (generateController) return; // already running
        errorBox.style.display = 'none';
        outputBox.style.display = 'none';
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating...';
        cancelBtn.style.display = '';
        generateController = new AbortController();
        const startedAt = performance.now();
        try {
            if (settings.test.backend === 'nai') {
                const blob = await nai.generate({
                    model: settings.backends.nai.model,
                    prompt: settings.test.prompt,
                    negative: settings.test.negative,
                    width: settings.test.width,
                    height: settings.test.height,
                    steps: settings.test.steps,
                    scale: settings.test.cfg,
                    seed: settings.test.seed,
                    signal: generateController.signal,
                });
                showImage(URL.createObjectURL(blob));
                captionEl.textContent = `NovelAI · ${settings.test.width}x${settings.test.height} · steps ${settings.test.steps}`;
            } else {
                const conn = currentSdConnection();
                const { models, stored } = activeCheckpointOptions();
                // The checkpoint must be a discovered model from the ACTIVE
                // source; dialect/profile names are never sent as a model.
                const checkpoint = resolveCheckpoint(models, stored);
                if (!checkpoint) {
                    throw new Error(`No valid checkpoint for the "${conn === 'a1111' ? 'AUTOMATIC1111-compatible API' : 'Comfy Cloud Proxy (Legacy)'}" connection. Open Backends, click Refresh Models, and select a checkpoint (profile ≠ model: family names like anima/krea2/illustrious are not checkpoints).`);
                }
                if (conn === 'a1111') {
                    const result = await a1111.txt2img({
                        prompt: settings.test.prompt,
                        negative_prompt: settings.test.negative,
                        checkpoint,
                        seed: settings.test.seed,
                        width: settings.test.width,
                        height: settings.test.height,
                        steps: settings.test.steps,
                        cfg_scale: settings.test.cfg,
                    }, { signal: generateController.signal });
                    showImage(result.dataUrl);
                    captionEl.textContent = `A1111 · ${checkpoint} · ${settings.test.width}x${settings.test.height}`;
                } else {
                    const result = await comfy.txt2img({
                        prompt: settings.test.prompt,
                        negative_prompt: settings.test.negative,
                        model: checkpoint,
                        seed: settings.test.seed,
                        width: settings.test.width,
                        height: settings.test.height,
                        steps: settings.test.steps,
                        cfg_scale: settings.test.cfg,
                    }, { signal: generateController.signal });
                    showImage(result.dataUrl);
                    captionEl.textContent = `Comfy proxy · ${checkpoint} · ${settings.test.width}x${settings.test.height}`;
                }
            }
            elapsedEl.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
        } catch (err) {
            if (err?.name === 'AbortError' || err?.code === 'A1111_ABORTED') {
                errorBox.textContent = 'Generation cancelled. Only the browser request was aborted — the server (if it received the job) may still be processing it.';
            } else {
                errorBox.textContent = err.message;
            }
            errorBox.style.display = '';
            disposeImage();
        } finally {
            generateController = null;
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate';
            cancelBtn.style.display = 'none';
        }
    });

    // ================= Characters Tab Wiring =================
    const charSelect = $('if_char_select');
    const charNewBtn = $('if_char_new');
    const charName = $('if_char_name');
    const charAliases = $('if_char_aliases');
    const charCount = $('if_char_count');
    const charBooru = $('if_char_booru');
    const charNatural = $('if_char_natural');
    const charFacts = $('if_char_facts');
    const charViewsBack = $('if_char_views_back');
    const charNsfwExtra = $('if_char_nsfw_extra');
    const charNegative = $('if_char_negative');
    const charLockSeed = $('if_char_lock_seed');
    const charLockSeedValue = $('if_char_lock_seed_value');
    const charMatrix = $('if_char_matrix');
    const charOutfitsList = $('if_char_outfits_list');
    const charOutfitName = $('if_char_outfit_name');
    const charOutfitTags = $('if_char_outfit_tags');
    const charOutfitCommon = $('if_char_outfit_common');
    const charOutfitAdd = $('if_char_outfit_add');
    const charSaveBtn = $('if_char_save');
    const charDelBtn = $('if_char_del');
    const charStatus = $('if_char_status');

    let currentChars = [];
    let activeCharId = null;
    let currentOutfits = []; // outfits for the active character (own + common)
    let activeOutfitId = null;

    async function loadCharactersList() {
        try {
            currentChars = await getAllCharacters();
            charSelect.innerHTML = '<option value="">-- New Character --</option>' +
                currentChars.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
            if (activeCharId) charSelect.value = activeCharId;
        } catch (e) {
            console.warn('[IF Image] Load characters failed:', e);
        }
    }
    loadCharactersList();

    // ---- D7: preset export/import -----------------------------------------
    const presetExportBtn = $('if_preset_export');
    const presetImportBtn = $('if_preset_import');
    const presetImportMode = $('if_preset_import_mode');
    const presetImportFile = $('if_preset_import_file');
    const presetStatus = $('if_preset_status');

    if (presetExportBtn) presetExportBtn.addEventListener('click', async () => {
        try {
            const [characters, outfits, styles, personas, replaceRules] = await Promise.all([
                getAllCharacters(), getAllOutfits(), getAllStyles(), getAllPersonas(), getReplaceRules(),
            ]);
            const doc = buildExport({
                characters, outfits, styles, personas, replaceRules,
                checkpointProfiles: settings.backends?.a1111?.checkpointProfiles ?? {},
            });
            const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `if-image-preset-${new Date().toISOString().slice(0, 10)}.ifimage.json`;
            a.click();
            // Revoked after the click has handed the URL to the download.
            setTimeout(() => URL.revokeObjectURL(url), 0);
            showResult(presetStatus, `Exported ${characters.length} characters, ${outfits.length} outfits, ${styles.length} styles, ${personas.length} personas, ${replaceRules.length} rules.`, false);
        } catch (e) {
            showResult(presetStatus, `Export failed: ${e.message}`, true);
        }
    });

    if (presetImportBtn) presetImportBtn.addEventListener('click', () => presetImportFile?.click());
    if (presetImportFile) presetImportFile.addEventListener('change', async () => {
        const file = presetImportFile.files?.[0];
        presetImportFile.value = ''; // re-selecting the same file re-fires change
        if (!file) return;
        try {
            const json = JSON.parse(await file.text());
            const { ok, errors } = validateImport(json);
            if (!ok) {
                showResult(presetStatus, `Invalid preset: ${errors.slice(0, 3).join(' ')}`, true);
                return;
            }
            const [characters, outfits, styles, personas, replaceRules] = await Promise.all([
                getAllCharacters(), getAllOutfits(), getAllStyles(), getAllPersonas(), getReplaceRules(),
            ]);
            const mode = presetImportMode?.value === 'overwrite' ? 'overwrite' : 'keep-mine';
            const plan = planMerge(
                { characters, outfits, styles, personas, replaceRules, checkpointProfiles: settings.backends?.a1111?.checkpointProfiles ?? {} },
                json, mode,
            );
            // Persist: characters run through CHAR_MIGRATORS before storing.
            for (const c of [...plan.characters.add, ...plan.characters.overwrite]) await saveCharacter(applyCharMigrations(c));
            for (const o of [...plan.outfits.add, ...plan.outfits.overwrite]) await saveOutfit(o);
            for (const s of [...plan.styles.add, ...plan.styles.overwrite]) await saveStyle(s);
            for (const p of [...plan.personas.add, ...plan.personas.overwrite]) await savePersona(p);
            if (plan.replaceRules.add.length || plan.replaceRules.overwrite.length) {
                const byTrigger = new Map(replaceRules.map(r => [String(r.trigger).trim().toLowerCase(), r]));
                for (const rule of [...plan.replaceRules.add, ...plan.replaceRules.overwrite]) {
                    byTrigger.set(String(rule.trigger).trim().toLowerCase(), rule);
                }
                await saveReplaceRules(Array.from(byTrigger.values()));
            }
            if (plan.checkpointProfiles.add.length || plan.checkpointProfiles.overwrite.length) {
                const target = ((settings.backends.a1111.checkpointProfiles ??= {}));
                for (const { title, entry } of [...plan.checkpointProfiles.add, ...plan.checkpointProfiles.overwrite]) {
                    target[title] = entry;
                }
                save();
            }
            const added = Object.values(plan).reduce((n, p) => n + p.add.length, 0);
            const overwritten = Object.values(plan).reduce((n, p) => n + p.overwrite.length, 0);
            const skipped = Object.values(plan).reduce((n, p) => n + p.skip.length, 0);
            showResult(presetStatus, `Import done: ${added} added, ${overwritten} overwritten, ${skipped} skipped (${mode}).`, false);
            await loadCharactersList();
        } catch (e) {
            showResult(presetStatus, `Import failed: ${e.message}`, true);
        }
    });

    function matrixCells() {
        return Array.from(charMatrix.querySelectorAll('tr[data-region]')).flatMap(row => {
            const region = row.dataset.region;
            return Array.from(row.querySelectorAll('input[data-cell]')).map(input => ({ region, path: input.dataset.cell, input }));
        });
    }

    function populateMatrix(detail) {
        const source = detail || emptyBooruDetail();
        for (const { region, path, input } of matrixCells()) {
            const [rating, view] = path.split('.');
            input.value = source[region]?.[rating]?.[view] ?? '';
        }
    }

    function readMatrix() {
        const detail = emptyBooruDetail();
        for (const { region, path, input } of matrixCells()) {
            const [rating, view] = path.split('.');
            detail[region][rating][view] = input.value.trim();
        }
        return detail;
    }

    async function loadOutfitsForActiveChar() {
        activeOutfitId = null;
        if (!activeCharId) { currentOutfits = []; renderOutfitsList(); return; }
        try {
            currentOutfits = await getOutfitsForCharacter(activeCharId);
        } catch (e) {
            console.warn('[IF Image] Load outfits failed:', e);
            currentOutfits = [];
        }
        renderOutfitsList();
    }

    function renderOutfitsList() {
        if (!currentOutfits.length) { charOutfitsList.textContent = 'No outfits yet.'; return; }
        charOutfitsList.innerHTML = currentOutfits.map(o => `
            <div class="if-image-log-entry" data-outfit-id="${escapeHtml(o.id)}">
                <span class="if-image-log-type">${o.charId ? 'own' : 'common'}</span>
                ${escapeHtml(o.name)}: ${escapeHtml(o.tags)}
                <button class="ifimg-outfit-edit menu_button" data-outfit-id="${escapeHtml(o.id)}">Edit</button>
                <button class="ifimg-outfit-del menu_button" data-outfit-id="${escapeHtml(o.id)}" style="background:#552222;">Delete</button>
            </div>`).join('');
        charOutfitsList.querySelectorAll('.ifimg-outfit-edit').forEach(btn => {
            btn.addEventListener('click', () => {
                const outfit = currentOutfits.find(o => o.id === btn.dataset.outfitId);
                if (!outfit) return;
                activeOutfitId = outfit.id;
                charOutfitName.value = outfit.name;
                charOutfitTags.value = outfit.tags;
                charOutfitCommon.checked = !outfit.charId;
            });
        });
        charOutfitsList.querySelectorAll('.ifimg-outfit-del').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await removeOutfit(btn.dataset.outfitId);
                    await loadOutfitsForActiveChar();
                    showResult(charStatus, 'Outfit deleted.', false);
                } catch (e) {
                    showResult(charStatus, e.message, true);
                }
            });
        });
    }

    charOutfitAdd.addEventListener('click', async () => {
        if (!activeCharId) {
            showResult(charStatus, 'Save the character before adding outfits.', true);
            return;
        }
        const name = charOutfitName.value.trim();
        if (!name) { showResult(charStatus, 'Outfit name is required.', true); return; }
        const outfit = activeOutfitId
            ? currentOutfits.find(o => o.id === activeOutfitId) || createDefaultOutfit(name)
            : createDefaultOutfit(name);
        outfit.name = name;
        outfit.tags = charOutfitTags.value.trim();
        outfit.charId = charOutfitCommon.checked ? null : activeCharId;
        try {
            await saveOutfit(outfit);
            activeOutfitId = null;
            charOutfitName.value = '';
            charOutfitTags.value = '';
            charOutfitCommon.checked = false;
            await loadOutfitsForActiveChar();
            showResult(charStatus, `Outfit "${name}" saved.`, false);
        } catch (e) {
            showResult(charStatus, e.message, true);
        }
    });

    function populateCharForm(char) {
        if (!char) {
            activeCharId = null;
            charName.value = '';
            charAliases.value = '';
            charCount.value = '1girl';
            charBooru.value = '';
            charNatural.value = '';
            charFacts.value = '';
            charViewsBack.value = '';
            charNsfwExtra.value = '';
            charNegative.value = '';
            charLockSeed.checked = false;
            charLockSeedValue.value = '-1';
            populateMatrix(null);
            loadOutfitsForActiveChar();
            return;
        }
        activeCharId = char.id;
        charName.value = char.name || '';
        charAliases.value = (char.aliases || []).join(', ');
        charCount.value = char.countTag || '1girl';
        charBooru.value = char.booru || '';
        charNatural.value = char.natural || '';
        charFacts.value = char.facts || '';
        charViewsBack.value = char.views?.back || '';
        charNsfwExtra.value = char.nsfwExtra || '';
        charNegative.value = char.negative || '';
        charLockSeed.checked = Number.isInteger(char.lock?.seed) && char.lock.seed >= 0;
        charLockSeedValue.value = String(char.lock?.seed ?? -1);
        populateMatrix(char.booruDetail);
        loadOutfitsForActiveChar();
    }

    charSelect.addEventListener('change', () => {
        const found = currentChars.find(c => c.id === charSelect.value);
        populateCharForm(found);
    });

    charNewBtn.addEventListener('click', () => {
        charSelect.value = '';
        populateCharForm(null);
    });

    charSaveBtn.addEventListener('click', async () => {
        const name = charName.value.trim();
        if (!name) {
            showResult(charStatus, 'Character name cannot be empty', true);
            return;
        }
        let target = currentChars.find(c => c.id === activeCharId);
        if (!target) {
            target = createDefaultCharacter(name);
        }
        target.name = name;
        target.aliases = charAliases.value.split(',').map(s => s.trim()).filter(Boolean);
        target.countTag = charCount.value.trim() || '1girl';
        target.booru = charBooru.value.trim();
        target.natural = charNatural.value.trim();
        target.facts = charFacts.value.trim();
        target.views = { ...(target.views || {}), back: charViewsBack.value.trim() };
        target.nsfwExtra = charNsfwExtra.value.trim();
        target.negative = charNegative.value.trim();
        const seedValue = Number(charLockSeedValue.value);
        target.lock = { seed: charLockSeed.checked && Number.isFinite(seedValue) ? seedValue : -1, params: target.lock?.params ?? null };
        target.booruDetail = readMatrix();

        try {
            await saveCharacter(target);
            activeCharId = target.id;
            await loadCharactersList();
            await loadOutfitsForActiveChar();
            showResult(charStatus, `Character "${name}" saved!`, false);
        } catch (err) {
            showResult(charStatus, err.message, true);
        }
    });

    charDelBtn.addEventListener('click', async () => {
        if (!activeCharId) return;
        try {
            await removeCharacter(activeCharId);
            activeCharId = null;
            populateCharForm(null);
            await loadCharactersList();
            showResult(charStatus, 'Character deleted.', false);
        } catch (err) {
            showResult(charStatus, err.message, true);
        }
    });

    // ================= Persona & Style Wiring =================
    const perSelect = $('if_per_select');
    const perNewBtn = $('if_per_new');
    const perDelBtn = $('if_per_del');
    const perName = $('if_per_name');
    const perDefault = $('if_per_default');
    const perPov = $('if_per_pov');
    const perBooru = $('if_per_booru');
    const perNatural = $('if_per_natural');
    const perFacts = $('if_per_facts');
    const perAvoid = $('if_per_avoid');
    const perSaveBtn = $('if_per_save');

    const styleSelect = $('if_style_select');
    const styleNewBtn = $('if_style_new');
    const styleDelBtn = $('if_style_del');
    const styleName = $('if_style_name');
    const styleKrea = $('if_style_krea');
    const styleKreaLight = $('if_style_krea_light');
    const styleKreaCam = $('if_style_krea_cam');
    const styleAnimaTags = $('if_style_anima_tags');
    const styleAnimaArtists = $('if_style_anima_artists');
    const styleIllus = $('if_style_illus');
    const styleIllusQuality = $('if_style_illus_quality');
    const styleIllusNeg = $('if_style_illus_neg');
    const styleSaveBtn = $('if_style_save');
    const presetsStatus = $('if_presets_status');

    let currentPersonas = [];
    let currentStyles = [];
    let activePersonaId = null;
    let activeStyleId = null;

    function populatePersonaForm(p) {
        activePersonaId = p?.id ?? null;
        perName.value = p?.name ?? 'Default User';
        perDefault.checked = Boolean(p?.isDefault);
        perPov.value = p?.povMode ?? 'auto';
        perBooru.value = p?.booru ?? '';
        perNatural.value = p?.natural ?? '';
        perFacts.value = p?.facts ?? '';
        perAvoid.value = (p?.avoidTags || []).join(', ');
    }

    function populateStyleForm(s) {
        activeStyleId = s?.id ?? null;
        styleName.value = s?.name ?? '';
        styleKrea.value = s?.dialectHints?.krea?.stylePhrase ?? '';
        styleKreaLight.value = s?.dialectHints?.krea?.lighting ?? '';
        styleKreaCam.value = s?.dialectHints?.krea?.camera ?? '';
        styleAnimaTags.value = s?.dialectHints?.anima?.booruTags ?? '';
        styleAnimaArtists.value = s?.dialectHints?.anima?.artists ?? '';
        styleIllus.value = s?.dialectHints?.illus?.artists ?? '';
        styleIllusQuality.value = s?.dialectHints?.illus?.qualityPrefix ?? '';
        styleIllusNeg.value = s?.dialectHints?.illus?.negativeTags ?? '';
    }

    function refreshPersonaSelect() {
        perSelect.innerHTML = '<option value="">-- New Persona --</option>' +
            currentPersonas.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.isDefault ? ' (default)' : ''}</option>`).join('');
        if (activePersonaId) perSelect.value = activePersonaId;
    }

    function refreshStyleSelect() {
        styleSelect.innerHTML = '<option value="">-- New Style --</option>' +
            currentStyles.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
        if (activeStyleId) styleSelect.value = activeStyleId;
    }

    async function loadPresets() {
        try {
            currentPersonas = await getAllPersonas();
            currentStyles = await getAllStyles();
            refreshPersonaSelect();
            refreshStyleSelect();
            const activePersona = currentPersonas.find(p => p.id === activePersonaId)
                ?? currentPersonas.find(p => p.isDefault)
                ?? currentPersonas[0]
                ?? null;
            populatePersonaForm(activePersona);
            refreshPersonaSelect();
            const activeStyle = currentStyles.find(s => s.id === activeStyleId) ?? null;
            populateStyleForm(activeStyle);
        } catch (e) {
            console.warn('[IF Image] Presets load error:', e);
        }
    }
    loadPresets();

    perSelect.addEventListener('change', () => {
        populatePersonaForm(currentPersonas.find(p => p.id === perSelect.value) ?? null);
    });
    perNewBtn.addEventListener('click', () => {
        perSelect.value = '';
        populatePersonaForm(null);
    });
    perDelBtn.addEventListener('click', async () => {
        if (!activePersonaId) return;
        try {
            await removePersona(activePersonaId);
            activePersonaId = null;
            await loadPresets();
            showResult(presetsStatus, 'Persona deleted.', false);
        } catch (e) {
            showResult(presetsStatus, e.message, true);
        }
    });

    perSaveBtn.addEventListener('click', async () => {
        const name = perName.value.trim();
        if (!name) { showResult(presetsStatus, 'Persona name is required', true); return; }
        try {
            const existing = currentPersonas.find(p => p.id === activePersonaId);
            const p = existing || createDefaultPersona(name);
            p.name = name;
            p.povMode = perPov.value;
            p.booru = perBooru.value.trim();
            p.natural = perNatural.value.trim();
            p.facts = perFacts.value.trim();
            p.avoidTags = perAvoid.value.split(',').map(s => s.trim()).filter(Boolean);
            p.isDefault = perDefault.checked;
            await savePersona(p);
            // Only one persona may be default at a time.
            if (p.isDefault) {
                for (const other of currentPersonas) {
                    if (other.id !== p.id && other.isDefault) {
                        other.isDefault = false;
                        await savePersona(other);
                    }
                }
            }
            activePersonaId = p.id;
            await loadPresets();
            showResult(presetsStatus, 'Persona saved!', false);
        } catch (e) {
            showResult(presetsStatus, e.message, true);
        }
    });

    styleSelect.addEventListener('change', () => {
        populateStyleForm(currentStyles.find(s => s.id === styleSelect.value) ?? null);
    });
    styleNewBtn.addEventListener('click', () => {
        styleSelect.value = '';
        populateStyleForm(null);
    });
    styleDelBtn.addEventListener('click', async () => {
        if (!activeStyleId) return;
        try {
            await removeStyle(activeStyleId);
            activeStyleId = null;
            await loadPresets();
            showResult(presetsStatus, 'Style deleted.', false);
        } catch (e) {
            showResult(presetsStatus, e.message, true);
        }
    });

    styleSaveBtn.addEventListener('click', async () => {
        const name = styleName.value.trim();
        if (!name) {
            showResult(presetsStatus, 'Style name is required', true);
            return;
        }
        try {
            const existing = currentStyles.find(s => s.id === activeStyleId);
            const s = existing || createDefaultStyle(name);
            s.name = name;
            s.dialectHints.krea.stylePhrase = styleKrea.value.trim();
            s.dialectHints.krea.lighting = styleKreaLight.value.trim();
            s.dialectHints.krea.camera = styleKreaCam.value.trim();
            s.dialectHints.anima.booruTags = styleAnimaTags.value.trim();
            s.dialectHints.anima.artists = styleAnimaArtists.value.trim();
            s.dialectHints.illus.artists = styleIllus.value.trim();
            s.dialectHints.illus.qualityPrefix = styleIllusQuality.value.trim();
            s.dialectHints.illus.negativeTags = styleIllusNeg.value.trim();
            await saveStyle(s);
            activeStyleId = s.id;
            await loadPresets();
            showResult(presetsStatus, `Style "${name}" saved!`, false);
        } catch (e) {
            showResult(presetsStatus, e.message, true);
        }
    });


    // ================= Replace Rules Wiring =================
    const replaceList = $('if_replace_list');
    const replaceTrigger = $('if_replace_trigger');
    const replaceMode = $('if_replace_mode');
    const replaceReplacement = $('if_replace_replacement');
    const replaceCondition = $('if_replace_condition');
    const replaceAdd = $('if_replace_add');
    const replaceCompact = $('if_replace_compact');
    const replaceCompactAdd = $('if_replace_compact_add');
    const replacePreviewBtn = $('if_replace_preview');
    const replacePreviewOut = $('if_replace_preview_out');

    let currentRules = [];

    async function loadReplaceRules() {
        try {
            currentRules = await getReplaceRules();
        } catch (e) {
            console.warn('[IF Image] Load replace rules failed:', e);
            currentRules = [];
        }
        renderReplaceList();
    }

    function renderReplaceList() {
        if (!currentRules.length) { replaceList.textContent = 'No rules yet.'; return; }
        replaceList.innerHTML = currentRules.map((r, i) => `
            <div class="if-image-log-entry">
                <span class="if-image-log-type">${escapeHtml(r.mode)}</span>
                "${escapeHtml(r.trigger)}" &rarr; "${escapeHtml(r.replacement ?? '')}"
                ${r.condition ? ` [${escapeHtml(r.condition)}]` : ''}
                <button class="ifimg-rule-del menu_button" data-idx="${i}" style="background:#552222;">Delete</button>
            </div>`).join('');
        replaceList.querySelectorAll('.ifimg-rule-del').forEach(btn => {
            btn.addEventListener('click', async () => {
                currentRules.splice(Number(btn.dataset.idx), 1);
                await saveReplaceRules(currentRules);
                renderReplaceList();
            });
        });
    }
    loadReplaceRules();

    replaceAdd.addEventListener('click', async () => {
        const trigger = replaceTrigger.value.trim();
        if (!trigger) return;
        currentRules.push({
            trigger,
            mode: replaceMode.value,
            replacement: replaceReplacement.value.trim(),
            condition: replaceCondition.value.trim() || undefined,
        });
        await saveReplaceRules(currentRules);
        replaceTrigger.value = '';
        replaceReplacement.value = '';
        replaceCondition.value = '';
        renderReplaceList();
    });

    replaceCompactAdd.addEventListener('click', async () => {
        const rule = parseCompactRule(replaceCompact.value);
        if (!rule) return;
        currentRules.push(rule);
        await saveReplaceRules(currentRules);
        replaceCompact.value = '';
        renderReplaceList();
    });

    replacePreviewBtn.addEventListener('click', () => {
        try {
            const text = testPrompt.value.trim();
            if (!text) { replacePreviewOut.textContent = 'Test Gen prompt is empty.'; return; }
            const profileKey = testProfile.value || settings.generation.profile || 'anima';
            const profile = PROFILES[profileKey] ?? PROFILES.anima;
            const parsed = parseTriggers(text, {});
            const assembled = assemblePrompt(parsed, profile.dialect, profile);
            const ctx = { dialect: profile.dialect, nsfw: false, back: false, full: false };
            let envelope = applyReplaceRules(assembled, currentRules, 'pre', ctx);
            envelope = cleanupEnvelope(envelope, profile.dialect, { avoidTags: [], rating: 'nsfw' });
            envelope = applyReplaceRules(envelope, currentRules, 'final', ctx);
            replacePreviewOut.innerHTML = `<div><span class="k">before:</span> ${escapeHtml(assembled.prompt)}</div><div><span class="k">after:</span> ${escapeHtml(envelope.prompt)}</div>`;
            replacePreviewOut.classList.remove('error');
        } catch (e) {
            showResult(replacePreviewOut, e.message, true);
        }
    });

    // ================= Gallery Tab Wiring (C10) =================
    const galleryGrid = $('if_gallery_grid');
    const galleryPrevBtn = $('if_gallery_prev');
    const galleryNextBtn = $('if_gallery_next');
    const galleryPageLabel = $('if_gallery_page_label');
    const galleryDetail = $('if_gallery_detail');
    const galleryDetailImg = $('if_gallery_detail_img');
    const galleryDetailMeta = $('if_gallery_detail_meta');
    const galleryDetailDownload = $('if_gallery_detail_download');
    const galleryDetailRegen = $('if_gallery_detail_regen');
    const galleryDetailRepro = $('if_gallery_detail_repro');
    const galleryLockChar = $('if_gallery_lock_char');
    const galleryLockApply = $('if_gallery_lock_apply');
    const galleryDetailDelete = $('if_gallery_detail_delete');
    const galleryDetailClose = $('if_gallery_detail_close');
    const galleryDetailStatus = $('if_gallery_detail_status');

    const GALLERY_PAGE_SIZE = 24;
    let galleryPage = 0;
    let galleryTotal = 0;
    let galleryItems = [];
    // Object URLs are created here for display only (listImages() itself
    // never attaches one) and revoked on every reload/page change so a
    // closed gallery tab never leaks blob URLs.
    let galleryUrls = new Map(); // record id -> object URL
    let galleryDetailId = null;

    function galleryScope() {
        return $('if_gallery_scope_all')?.checked ? 'all' : 'chat';
    }

    function revokeGalleryUrls() {
        for (const url of galleryUrls.values()) URL.revokeObjectURL(url);
        galleryUrls.clear();
    }

    function closeGalleryDetail() {
        galleryDetailId = null;
        galleryDetail.style.display = 'none';
    }

    async function loadGalleryPage() {
        revokeGalleryUrls();
        closeGalleryDetail();
        const scope = galleryScope();
        const chatId = scope === 'chat' && typeof getCurrentChatId === 'function' ? getCurrentChatId() : undefined;
        try {
            const [items, total] = await Promise.all([
                listImages({ chatId, offset: galleryPage * GALLERY_PAGE_SIZE, limit: GALLERY_PAGE_SIZE }),
                countImages({ chatId }),
            ]);
            galleryItems = items;
            galleryTotal = total;
            renderGalleryGrid();
        } catch (e) {
            galleryGrid.textContent = '';
            console.warn('[IF Image] Gallery load failed:', e);
        }
        refreshGalleryStats(chatId);
    }

    // D6: "N images · X MB" header (blob records only, scope-aware).
    const galleryStats = $('if_gallery_stats');
    async function refreshGalleryStats(chatId) {
        if (!galleryStats) return;
        try {
            const { count, bytes } = await getStorageStats({ chatId });
            galleryStats.textContent = `${count} image${count === 1 ? '' : 's'} · ${(bytes / 1048576).toFixed(1)} MB`;
        } catch (e) {
            galleryStats.textContent = '';
            console.warn('[IF Image] Gallery stats failed:', e);
        }
    }

    function renderGalleryGrid() {
        for (const record of galleryItems) {
            galleryUrls.set(record.id, URL.createObjectURL(record.blob));
        }
        // Blob URLs are browser-generated (opaque, no user-controlled
        // characters) and safe to interpolate directly; every other field
        // still goes through escapeHtml via data-record-id lookups below.
        galleryGrid.innerHTML = galleryItems.map(record => `
            <div class="if-image-gallery-thumb" data-record-id="${escapeHtml(record.id)}">
                <img src="${galleryUrls.get(record.id)}" alt="Generated image">
            </div>`).join('');
        galleryGrid.querySelectorAll('[data-record-id]').forEach(node => {
            node.addEventListener('click', () => {
                const record = galleryItems.find(r => r.id === node.dataset.recordId);
                if (record) openGalleryDetail(record);
            });
        });
        const totalPages = Math.max(1, Math.ceil(galleryTotal / GALLERY_PAGE_SIZE));
        galleryPageLabel.textContent = `Page ${galleryPage + 1} / ${totalPages} (${galleryTotal} image${galleryTotal === 1 ? '' : 's'})`;
        galleryPrevBtn.disabled = galleryPage <= 0;
        galleryNextBtn.disabled = (galleryPage + 1) * GALLERY_PAGE_SIZE >= galleryTotal;
        if (!galleryItems.length) galleryGrid.textContent = 'No images yet.';
    }

    function openGalleryDetail(record) {
        galleryDetailId = record.id;
        const url = galleryUrls.get(record.id);
        galleryDetailImg.src = url;
        galleryDetailDownload.href = url;
        const when = record.timestamp ? new Date(record.timestamp).toLocaleString() : '(unknown time)';
        galleryDetailMeta.innerHTML = [
            `<span class="k">when:</span> ${escapeHtml(when)}`,
            `<span class="k">backend:</span> ${escapeHtml(record.backend || '(unknown)')}`,
            `<span class="k">profile:</span> ${escapeHtml(record.profileKey || '(unknown)')}`,
            `<span class="k">size:</span> ${record.width || '?'}x${record.height || '?'} · seed ${record.seed ?? '?'}`,
            `<span class="k">prompt:</span> ${escapeHtml(record.prompt || '')}`,
        ].join('<br>');
        showResult(galleryDetailStatus, '', false);
        // D2: Repro/Lock need a concrete non-random seed to be meaningful.
        const hasSeed = Number.isInteger(record.seed) && record.seed >= 0;
        galleryDetailRepro.disabled = !hasSeed;
        galleryLockApply.disabled = !hasSeed;
        populateGalleryLockSelect();
        galleryDetail.style.display = '';
    }

    // D2: roster select for "Lock seed to character". Loaded on each detail
    // open so it reflects characters added since the drawer mounted.
    async function populateGalleryLockSelect() {
        try {
            const chars = await getAllCharacters();
            galleryLockChar.innerHTML = '<option value="">-- select character --</option>' +
                chars.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
        } catch (e) {
            console.warn('[IF Image] Lock-seed roster load failed:', e);
        }
    }

    galleryLockApply.addEventListener('click', async () => {
        if (!galleryDetailId || !galleryLockChar.value) return;
        const record = galleryItems.find(r => r.id === galleryDetailId);
        if (!record || !Number.isInteger(record.seed) || record.seed < 0) return;
        try {
            const chars = await getAllCharacters();
            const target = chars.find(c => c.id === galleryLockChar.value);
            if (!target) { showResult(galleryDetailStatus, 'Character not found.', true); return; }
            target.lock = { seed: record.seed, params: target.lock?.params ?? null };
            await saveCharacter(target);
            showResult(galleryDetailStatus, `Locked seed ${record.seed} to ${target.name}.`, false);
            // Refresh the character editor if that character is open there.
            if (activeCharId === target.id) {
                await loadCharactersList();
                charLockSeed.checked = true;
                charLockSeedValue.value = String(record.seed);
            }
        } catch (e) {
            showResult(galleryDetailStatus, e.message, true);
        }
    });

    galleryDetailRepro.addEventListener('click', async () => {
        if (!galleryDetailId) return;
        const record = galleryItems.find(r => r.id === galleryDetailId);
        if (!record || typeof regenerateImage !== 'function') return;
        galleryDetailRepro.disabled = true;
        showResult(galleryDetailStatus, `Reproducing with seed ${record.seed}...`, false);
        try {
            await regenerateImage(record, { seed: record.seed });
            showResult(galleryDetailStatus, 'Reproduced — a new record was saved.', false);
            galleryPage = 0;
            await loadGalleryPage();
        } catch (e) {
            showResult(galleryDetailStatus, e.message, true);
        } finally {
            galleryDetailRepro.disabled = false;
        }
    });

    galleryPrevBtn.addEventListener('click', () => {
        if (galleryPage <= 0) return;
        galleryPage -= 1;
        loadGalleryPage();
    });
    galleryNextBtn.addEventListener('click', () => {
        if ((galleryPage + 1) * GALLERY_PAGE_SIZE >= galleryTotal) return;
        galleryPage += 1;
        loadGalleryPage();
    });
    el.querySelectorAll('input[name="if_gallery_scope"]').forEach(radio => {
        radio.addEventListener('change', () => {
            galleryPage = 0;
            loadGalleryPage();
        });
    });
    galleryDetailClose.addEventListener('click', closeGalleryDetail);

    // ---- D6: cache management (prune buttons + settings inputs) ----------
    const pruneOldBtn = $('if_gallery_prune_old');
    const pruneDaysEl = $('if_gallery_prune_days');
    const pruneChatBtn = $('if_gallery_prune_chat');
    if (pruneOldBtn) pruneOldBtn.addEventListener('click', async () => {
        const days = Number(pruneDaysEl?.value);
        if (!Number.isFinite(days) || days < 1) return;
        if (!confirm(`Delete images older than ${days} day(s)? Each marker keeps its newest image.`)) return;
        try {
            const { deleted, bytesFreed } = await pruneImages({ olderThanMs: days * 86400000 });
            showResult(galleryDetailStatus, `Deleted ${deleted} image(s), freed ${(bytesFreed / 1048576).toFixed(1)} MB.`, false);
            galleryPage = 0;
            await loadGalleryPage();
        } catch (e) {
            showResult(galleryDetailStatus, e.message, true);
        }
    });
    if (pruneChatBtn) pruneChatBtn.addEventListener('click', async () => {
        const chatId = typeof getCurrentChatId === 'function' ? getCurrentChatId() : undefined;
        if (!chatId) { showResult(galleryDetailStatus, 'No active chat.', true); return; }
        if (!confirm('Delete ALL images in this chat? Each marker keeps its newest image.')) return;
        try {
            // olderThanMs: everything qualifies; the newest-per-slot rule
            // still protects each marker's latest image.
            const { deleted, bytesFreed } = await pruneImages({ chatId, olderThanMs: 1 });
            showResult(galleryDetailStatus, `Deleted ${deleted} image(s), freed ${(bytesFreed / 1048576).toFixed(1)} MB.`, false);
            galleryPage = 0;
            await loadGalleryPage();
        } catch (e) {
            showResult(galleryDetailStatus, e.message, true);
        }
    });
    // Cache settings (migrator v7 defaults 0/0/0 = all off).
    const cacheDefaults = () => (settings.cache ??= { ttlDays: 0, maxMB: 0, jpegQuality: 0 });
    const cacheInput = (id, key, max) => {
        const input = $(id);
        if (!input) return;
        input.value = String(cacheDefaults()[key] ?? 0);
        input.addEventListener('change', () => {
            let n = Math.max(0, Math.round(Number(input.value) || 0));
            if (max !== undefined) n = Math.min(max, n);
            input.value = String(n);
            cacheDefaults()[key] = n;
            save();
        });
    };
    cacheInput('if_cache_ttl', 'ttlDays');
    cacheInput('if_cache_maxmb', 'maxMB');
    cacheInput('if_cache_jpegq', 'jpegQuality', 100);

    galleryDetailDelete.addEventListener('click', async () => {
        if (!galleryDetailId) return;
        try {
            await deleteImageRecord(galleryDetailId);
            showResult(galleryDetailStatus, 'Deleted.', false);
            await loadGalleryPage();
        } catch (e) {
            showResult(galleryDetailStatus, e.message, true);
        }
    });

    galleryDetailRegen.addEventListener('click', async () => {
        if (!galleryDetailId) return;
        const record = galleryItems.find(r => r.id === galleryDetailId);
        if (!record) return;
        if (typeof regenerateImage !== 'function') {
            showResult(galleryDetailStatus, 'Regenerate is unavailable in this context.', true);
            return;
        }
        galleryDetailRegen.disabled = true;
        showResult(galleryDetailStatus, 'Regenerating...', false);
        try {
            await regenerateImage(record);
            showResult(galleryDetailStatus, 'Regenerated — a new image was added to the gallery.', false);
            galleryPage = 0;
            await loadGalleryPage();
        } catch (e) {
            showResult(galleryDetailStatus, e.message, true);
        } finally {
            galleryDetailRegen.disabled = false;
        }
    });

    // Loaded lazily on first activation, not on drawer mount, so opening the
    // extensions panel never triggers an IndexedDB round-trip for a tab the
    // user hasn't looked at.
    let galleryLoaded = false;
    el.querySelector('[data-if-tab="gallery"]')?.addEventListener('click', () => {
        if (galleryLoaded) return;
        galleryLoaded = true;
        loadGalleryPage();
    });

    // ================= 3-Dialect Preview: Character Picker (C9) =================
    const renderPicker = $('if_render_picker');
    const renderInsertBtn = $('if_render_insert');
    const renderClearBtn = $('if_render_clear');

    let pickerRoster = [];
    let pickerOutfits = [];
    let pickerHasPersona = false;

    function pickerRowHtml(id, label, outfits) {
        const outfitOptions = outfits.length
            ? outfits.map(o => `<option value="${escapeHtml(o.name)}">${escapeHtml(o.name)}${o.charId ? '' : ' (common)'}</option>`).join('')
            : '';
        return `
            <div class="if-image-log-entry" data-picker-id="${escapeHtml(id)}">
                <label class="if-image-check"><input type="checkbox" class="if-picker-select"> ${escapeHtml(label)}</label>
                <label class="if-image-check"><input type="checkbox" class="if-picker-back"> back</label>
                <label class="if-image-check"><input type="checkbox" class="if-picker-full"> full</label>
                <label class="if-image-check"><input type="checkbox" class="if-picker-nsfw"> nsfw</label>
                ${outfits.length ? `<select class="if-picker-outfit text_pole"><option value="">-- outfit: none --</option>${outfitOptions}</select>` : ''}
            </div>`;
    }

    async function loadCharPicker() {
        try {
            pickerRoster = await getAllCharacters();
            const allOutfits = await (async () => {
                try {
                    const per = await Promise.all(pickerRoster.map(c => getOutfitsForCharacter(c.id)));
                    return per;
                } catch { return pickerRoster.map(() => []); }
            })();
            pickerOutfits = allOutfits;
            const personas = await getAllPersonas();
            pickerHasPersona = personas.length > 0;
        } catch (e) {
            console.warn('[IF Image] Character picker load failed:', e);
            pickerRoster = [];
            pickerOutfits = [];
            pickerHasPersona = false;
        }
        renderCharPicker();
    }

    function renderCharPicker() {
        if (!renderPicker) return;
        const rows = pickerRoster.map((c, i) => pickerRowHtml(c.id, c.name, pickerOutfits[i] || []));
        if (pickerHasPersona) rows.push(pickerRowHtml('__persona__', '$me (Persona)', []));
        renderPicker.innerHTML = rows.length ? rows.join('') : 'No characters yet — add some in the Characters tab.';
    }

    function pickerTokens() {
        if (!renderPicker) return [];
        const tokens = [];
        renderPicker.querySelectorAll('[data-picker-id]').forEach(row => {
            if (!row.querySelector('.if-picker-select')?.checked) return;
            const mods = [];
            if (row.querySelector('.if-picker-back')?.checked) mods.push('back');
            if (row.querySelector('.if-picker-full')?.checked) mods.push('full');
            if (row.querySelector('.if-picker-nsfw')?.checked) mods.push('nsfw');
            const outfit = row.querySelector('.if-picker-outfit')?.value;
            if (outfit) mods.push(outfit);
            const id = row.dataset.pickerId;
            if (id === '__persona__') {
                tokens.push(mods.length ? `$me:${mods.join('|')}` : '$me');
                return;
            }
            const char = pickerRoster.find(c => c.id === id);
            if (!char) return;
            tokens.push(mods.length ? `$${char.name}:${mods.join('|')}` : `$${char.name}`);
        });
        return tokens;
    }

    if (renderInsertBtn) renderInsertBtn.addEventListener('click', () => {
        const tokens = pickerTokens();
        if (!tokens.length) return;
        const current = renderInput.value.trim();
        renderInput.value = current ? `${tokens.join(' ')} ${current}` : tokens.join(' ');
    });
    if (renderClearBtn) renderClearBtn.addEventListener('click', () => { renderInput.value = ''; });

    loadCharPicker();

    // ================= 3-Dialect Preview Wiring =================
    const renderInput = $('if_render_input');
    const renderBtn = $('if_render_btn');

    function renderPreviewBlock(dialect, output, active) {
        const block = el.querySelector(`[data-if-dialect="${dialect}"]`);
        if (!block) return;
        block.classList.toggle('active', active);
        const promptEl = block.querySelector('.if-render-prompt');
        const negEl = block.querySelector('.if-render-negative');
        const paramsEl = block.querySelector('.if-render-params');
        // R4: prompt/negative are user-typed trigger text — escape them.
        if (promptEl) promptEl.innerHTML = `<span class="k">prompt:</span> ${escapeHtml(output.prompt || '(empty)')}`;
        if (negEl) negEl.innerHTML = `<span class="k">negative:</span> ${escapeHtml(output.negative || '(none)')}`;
        if (paramsEl) paramsEl.innerHTML = `<span class="k">params:</span> W=${escapeHtml(output.params.width)} H=${escapeHtml(output.params.height)} steps=${escapeHtml(output.params.steps)} cfg=${escapeHtml(output.params.cfg)}`;
    }

    renderBtn.addEventListener('click', async () => {
        const text = renderInput.value.trim();
        if (!text) return;
        try {
            const roster = await getAllCharacters();
            const styles = await getAllStyles();
            const personas = await getAllPersonas();
            const parsed = parseTriggers(text, {
                roster,
                styles,
                defaultPersona: personas[0] || createDefaultPersona(),
            });

            const dialects = [
                { key: 'krea', profileKey: 'krea2' },
                { key: 'anima', profileKey: 'anima' },
                { key: 'illus', profileKey: 'illustrious' },
            ];
            // The pipeline's dialectOverride wins over the configured default
            // profile; mark the dialect it resolves to as active.
            const configured = settings.generation.profile || settings.backends.comfy.profile || 'anima';
            const { profileKey: resolvedKey } = resolveProfileKey(parsed.dialectOverride, configured);
            const activeDialect = PROFILES[resolvedKey]?.dialect ?? 'anima';
            for (const d of dialects) {
                const output = assemblePrompt(parsed, d.key, PROFILES[d.profileKey]);
                renderPreviewBlock(d.key, output, d.key === activeDialect);
            }
        } catch (err) {
            const kreaBlock = el.querySelector('[data-if-dialect="krea"]');
            if (kreaBlock) {
                const promptEl = kreaBlock.querySelector('.if-render-prompt');
                if (promptEl) promptEl.innerHTML = `<span class="k">error:</span> ${escapeHtml(err.message)}`;
            }
        }
    });

    // ================= Main Tab: dry-run toggle =================
    const dryRunEl = $('if_main_dryrun');
    if (dryRunEl) {
        dryRunEl.checked = settings.generation?.dryRun === true;
        dryRunEl.addEventListener('change', () => { settings.generation.dryRun = dryRunEl.checked; save(); });
    }

    // ================= Main Tab: D3 LLM size hint policy =================
    const llmSizeEl = $('if_main_llmsize');
    if (llmSizeEl) {
        llmSizeEl.value = ['auto', 'ignore', 'force'].includes(settings.generation?.llmSize)
            ? settings.generation.llmSize : 'auto';
        llmSizeEl.addEventListener('change', () => { settings.generation.llmSize = llmSizeEl.value; save(); });
    }

    // ================= Main Tab: Generation Params (C0) =================
    const paramsProfile = $('if_params_profile');
    const paramsWidth = $('if_params_width');
    const paramsHeight = $('if_params_height');
    const paramsSteps = $('if_params_steps');
    const paramsCfg = $('if_params_cfg');

    function currentParamsOverride() {
        if (!settings.generation.params) settings.generation.params = { krea2: {}, anima: {}, illustrious: {} };
        const key = paramsProfile.value;
        if (!settings.generation.params[key]) settings.generation.params[key] = {};
        return settings.generation.params[key];
    }

    function syncParamsForm() {
        const profile = PROFILES[paramsProfile.value];
        const override = currentParamsOverride();
        paramsWidth.value = override.width ?? '';
        paramsWidth.placeholder = String(profile?.width ?? '');
        paramsHeight.value = override.height ?? '';
        paramsHeight.placeholder = String(profile?.height ?? '');
        paramsSteps.value = override.steps ?? '';
        paramsSteps.placeholder = String(profile?.steps ?? '');
        paramsCfg.value = override.cfg ?? '';
        paramsCfg.placeholder = String(profile?.cfg ?? '');
    }
    if (paramsProfile) {
        paramsProfile.value = settings.generation.profile || 'anima';
        syncParamsForm();
        paramsProfile.addEventListener('change', syncParamsForm);

        const bindParam = (input, key, parse) => {
            input.addEventListener('change', () => {
                const override = currentParamsOverride();
                const raw = input.value.trim();
                if (!raw) { delete override[key]; save(); return; }
                const n = parse(raw);
                if (!Number.isFinite(n)) { delete override[key]; save(); return; }
                override[key] = n;
                save();
            });
        };
        bindParam(paramsWidth, 'width', Number);
        bindParam(paramsHeight, 'height', Number);
        bindParam(paramsSteps, 'steps', Number);
        bindParam(paramsCfg, 'cfg', Number);
    }

    // ================= LLM Tab Wiring =================
    const llmMethod = $('if_llm_default_method');
    const llmProfileSelect = $('if_llm_default_profile');
    const llmInjection = $('if_llm_injection');
    const llmProfSel = $('if_llm_profile_select');
    const llmProfNew = $('if_llm_profile_new');
    const llmProfDel = $('if_llm_profile_del');
    const llmProfName = $('if_llm_profile_name');
    const llmProfMethod = $('if_llm_profile_method');
    const llmProfUrl = $('if_llm_profile_baseurl');
    const llmProfKey = $('if_llm_profile_key');
    const llmProfModel = $('if_llm_profile_model');
    const llmProfTemp = $('if_llm_profile_temp');
    const llmProfMaxTok = $('if_llm_profile_maxtokens');
    const llmProfSave = $('if_llm_profile_save');
    const llmTestBtn = $('if_llm_test');
    const llmResult = $('if_llm_result');
    const llmMapApi = $('if_llm_map_api');
    const llmMapCtx = $('if_llm_map_ctx');
    const llmFetchRows = el.querySelectorAll('[data-if-llm-fetch]');

    if (llmMethod) llmMethod.value = settings.llm?.defaultMethod ?? 'direct';
    if (llmInjection) llmInjection.value = settings.llm?.injectionStyle ?? 'compact';

    function refreshLlmProfileSelects() {
        const profiles = settings.llm?.apiProfiles ?? [];
        const options = profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
        if (llmProfileSelect) llmProfileSelect.innerHTML = '<option value="">-- none --</option>' + options;
        if (llmProfSel) llmProfSel.innerHTML = '<option value="">-- New Profile --</option>' + options;
        if (llmMapApi) llmMapApi.innerHTML = '<option value="">-- none --</option>' + options;
        if (llmProfileSelect) llmProfileSelect.value = settings.llm?.defaultApiProfileId ?? '';
        if (llmMapApi) llmMapApi.value = settings.llm?.requestMapping?.image_gen?.apiProfileId ?? '';
    }

    function refreshContextProfileSelect() {
        const profiles = settings.llm?.contextProfiles ?? [];
        const options = profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
        if (llmMapCtx) {
            llmMapCtx.innerHTML = '<option value="">-- none --</option>' + options;
            llmMapCtx.value = settings.llm?.requestMapping?.image_gen?.contextProfileId ?? '';
        }
    }

    function syncLlmFetchRows() {
        const show = llmProfMethod?.value === 'direct_fetch';
        llmFetchRows.forEach(row => row.style.display = show ? '' : 'none');
    }

    if (llmMethod) llmMethod.addEventListener('change', () => { settings.llm.defaultMethod = llmMethod.value; save(); });
    if (llmProfileSelect) llmProfileSelect.addEventListener('change', () => { settings.llm.defaultApiProfileId = llmProfileSelect.value; save(); });
    if (llmInjection) llmInjection.addEventListener('change', () => { settings.llm.injectionStyle = llmInjection.value; save(); });

    let activeLlmProfileId = null;
    function populateLlmProfileForm(profile) {
        activeLlmProfileId = profile?.id ?? null;
        if (!profile) {
            if (llmProfName) llmProfName.value = '';
            if (llmProfMethod) llmProfMethod.value = 'generateRaw';
            if (llmProfUrl) llmProfUrl.value = '';
            if (llmProfKey) llmProfKey.value = '';
            if (llmProfModel) llmProfModel.value = '';
            if (llmProfTemp) llmProfTemp.value = '0.7';
            if (llmProfMaxTok) llmProfMaxTok.value = '4096';
            syncLlmFetchRows();
            return;
        }
        if (llmProfName) llmProfName.value = profile.name ?? '';
        if (llmProfMethod) llmProfMethod.value = profile.method ?? 'generateRaw';
        if (llmProfUrl) llmProfUrl.value = profile.baseUrl ?? '';
        if (llmProfKey) llmProfKey.value = profile.apiKey ?? '';
        if (llmProfModel) llmProfModel.value = profile.model ?? '';
        if (llmProfTemp) llmProfTemp.value = String(profile.temperature ?? 0.7);
        if (llmProfMaxTok) llmProfMaxTok.value = String(profile.maxTokens ?? 4096);
        syncLlmFetchRows();
    }

    if (llmProfSel) llmProfSel.addEventListener('change', () => {
        const profiles = settings.llm?.apiProfiles ?? [];
        const found = profiles.find(p => p.id === llmProfSel.value);
        populateLlmProfileForm(found);
    });
    if (llmProfNew) llmProfNew.addEventListener('click', () => { llmProfSel.value = ''; populateLlmProfileForm(null); });
    if (llmProfMethod) llmProfMethod.addEventListener('change', syncLlmFetchRows);

    if (llmProfDel) llmProfDel.addEventListener('click', () => {
        if (!activeLlmProfileId) return;
        const deletedId = activeLlmProfileId;
        const profiles = settings.llm?.apiProfiles ?? [];
        settings.llm.apiProfiles = profiles.filter(p => p.id !== deletedId);
        activeLlmProfileId = null;
        // Clean up mapping and default references
        for (const key of Object.keys(settings.llm.requestMapping ?? {})) {
            if (settings.llm.requestMapping[key]?.apiProfileId === deletedId) {
                settings.llm.requestMapping[key].apiProfileId = '';
            }
        }
        if (settings.llm.defaultApiProfileId === deletedId) settings.llm.defaultApiProfileId = '';
        refreshLlmProfileSelects();
        populateLlmProfileForm(null);
        save();
    });

    if (llmProfSave) llmProfSave.addEventListener('click', () => {
        if (!settings.llm) settings.llm = {};
        if (!Array.isArray(settings.llm.apiProfiles)) settings.llm.apiProfiles = [];
        const name = llmProfName?.value?.trim();
        if (!name) { showResult(llmResult, 'Profile name is required', true); return; }
        const profile = {
            id: activeLlmProfileId || (crypto.randomUUID ? crypto.randomUUID() : 'ap_' + Date.now()),
            name,
            method: llmProfMethod?.value ?? 'generateRaw',
            baseUrl: llmProfUrl?.value?.trim() ?? '',
            apiKey: llmProfKey?.value ?? '',
            model: llmProfModel?.value?.trim() ?? '',
            temperature: Number(llmProfTemp?.value) || 0.7,
            maxTokens: Number(llmProfMaxTok?.value) || 4096,
        };
        const idx = settings.llm.apiProfiles.findIndex(p => p.id === profile.id);
        if (idx >= 0) settings.llm.apiProfiles[idx] = profile;
        else settings.llm.apiProfiles.push(profile);
        activeLlmProfileId = profile.id;
        refreshLlmProfileSelects();
        save();
        showResult(llmResult, `Profile "${name}" saved!`, false);
    });

    // LLM test call
    if (llmTestBtn) llmTestBtn.addEventListener('click', async () => {
        llmTestBtn.disabled = true;
        showResult(llmResult, 'Testing...', false);
        try {
            // Lazy import: the module is always available since Phase B
            const { createLlmClient } = await import('./llm/client.js');
            const client = createLlmClient({
                getSettings: () => settings,
                getContext: () => (typeof SillyTavern !== 'undefined' && SillyTavern.getContext?.()) || {},
            });
            const result = await client.request({
                type: 'image_gen',
                systemPrompt: 'Reply with exactly one line: OK.',
                userPrompt: 'Reply with: OK',
                signal: AbortSignal.timeout(30000),
            });
            showResult(llmResult, `Test OK (${result.elapsedMs.toFixed(0)}ms): ${result.text.slice(0, 200)}`, false);
        } catch (err) {
            showResult(llmResult, `Test failed: ${err?.message ?? err}`, true);
        } finally {
            llmTestBtn.disabled = false;
        }
    });

    // Request mapping
    if (llmMapApi) llmMapApi.addEventListener('change', () => {
        if (!settings.llm.requestMapping) settings.llm.requestMapping = {};
        if (!settings.llm.requestMapping.image_gen) settings.llm.requestMapping.image_gen = {};
        settings.llm.requestMapping.image_gen.apiProfileId = llmMapApi.value;
        save();
    });
    if (llmMapCtx) llmMapCtx.addEventListener('change', () => {
        if (!settings.llm.requestMapping) settings.llm.requestMapping = {};
        if (!settings.llm.requestMapping.image_gen) settings.llm.requestMapping.image_gen = {};
        settings.llm.requestMapping.image_gen.contextProfileId = llmMapCtx.value;
        save();
    });

    refreshLlmProfileSelects();
    refreshContextProfileSelect();
    syncLlmFetchRows();

    // ================= Log Tab Wiring =================
    const logLimit = $('if_log_limit');
    const logRefresh = $('if_log_refresh');
    const logClear = $('if_log_clear');
    const logEntries = $('if_log_entries');
    const logTasksRefresh = $('if_log_tasks_refresh');
    const logTasks = $('if_log_tasks');

    if (logLimit) {
        logLimit.value = settings.generation?.logLimit ?? 50;
        logLimit.addEventListener('change', () => {
            settings.generation.logLimit = Math.max(1, Number(logLimit.value) || 50);
            save();
        });
    }


    function renderLogEntries() {
        if (!logEntries) return;
        const log = genLog ?? [];
        if (!log.length) { logEntries.textContent = 'No entries yet.'; return; }
        logEntries.innerHTML = log.slice().reverse().map(e => {
            const time = new Date(e.timestamp).toLocaleTimeString();
            const body = e.content ?? e.prompt ?? '';
            const detail = body ? `: ${escapeHtml(String(body).slice(0, 120))}` : '';
            const method = e.method ? ` [${escapeHtml(e.method)}]` : '';
            const error = e.error ? ` ⚠ ${escapeHtml(String(e.error).slice(0, 100))}` : '';
            return `<div class="if-image-log-entry"><span class="if-image-log-time">${time}</span> <span class="if-image-log-type">${escapeHtml(e.type)}</span>${method}${detail}${error}</div>`;
        }).join('');
    }

    if (logRefresh) logRefresh.addEventListener('click', renderLogEntries);
    if (logClear) logClear.addEventListener('click', () => {
        if (genLog) genLog.length = 0;
        renderLogEntries();
    });

    function renderTaskList() {
        if (!logTasks || !getQueue) return;
        const queue = getQueue();
        if (!queue || typeof queue.listTasks !== 'function') {
            logTasks.textContent = 'Queue unavailable.';
            return;
        }
        const tasks = queue.listTasks();
        if (!tasks.length) { logTasks.textContent = 'No tasks.'; return; }
        logTasks.innerHTML = tasks.map(t => {
            const promptText = typeof t.prompt === 'object' && t.prompt?.prompt
                ? String(t.prompt.prompt).slice(0, 80)
                : String(t.prompt ?? '').slice(0, 80);
            return `<div class="if-image-log-entry">
                <span class="if-image-log-type">${escapeHtml(t.status)}</span> ${escapeHtml(t.id)}: ${escapeHtml(promptText)}
                ${t.status === 'running' || t.status === 'queued' ? `<button class="ifimg-retry menu_button" data-task-id="${escapeHtml(t.id)}">Cancel</button>` : ''}
            </div>`;
        }).join('');
        // Wire cancel buttons
        logTasks.querySelectorAll('[data-task-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.taskId;
                queue.cancelTask(id);
                renderTaskList();
            });
        });
    }
    if (logTasksRefresh) logTasksRefresh.addEventListener('click', renderTaskList);

    return el;
}

// ---------------------------------------------------------------------------
// D4: edit-before-generate dialog. Exported as a factory so index.js can wire
// it into the marker pipeline (deps.openEditDialog) with the ST popup and the
// LLM tag-modify callback injected — ui.js never imports the engine itself.
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {() => object|null} deps.getContext - ST getContext (feature-detected:
 *   callGenericPopup + POPUP_TYPE.CONFIRM when present, else a self-built
 *   overlay so offline/degraded environments still work).
 * @param {(promptText: string, instruction: string, opts: {signal?: AbortSignal}) => Promise<{tags: string}>} [deps.modifyTags]
 *   AI assist hook (index.js wires engine.modifyTags). Optional: without it
 *   the assist row is hidden.
 * @param {(kind: string, message: string) => void} deps.notify
 * @param {object} deps.profiles - PROFILES map (for negativeDisabled).
 * @returns {(current: {prompt, negative, params, profileKey}) => Promise<object|null>}
 *   resolves to an envelope override { prompt, negative, params } or null on cancel.
 */
export function createEditDialog({ getContext, modifyTags, notify, profiles }) {
    return async function openEditDialog({ prompt = '', negative = '', params = {}, profileKey } = {}) {
        const doc = document;
        const form = doc.createElement('div');
        form.className = 'ifimg-edit-dialog';

        const field = (labelText, node) => {
            const wrap = doc.createElement('label');
            wrap.className = 'ifimg-edit-field';
            const span = doc.createElement('span');
            span.textContent = labelText;
            wrap.appendChild(span);
            wrap.appendChild(node);
            form.appendChild(wrap);
            return node;
        };
        const promptEl = doc.createElement('textarea');
        promptEl.rows = 5;
        promptEl.value = String(prompt);
        field('Prompt', promptEl);

        // AI assist: rewrites the prompt textarea via the LLM; NEVER generates.
        let abortAssist = null;
        if (typeof modifyTags === 'function') {
            const row = doc.createElement('div');
            row.className = 'ifimg-edit-assist';
            const instrEl = doc.createElement('input');
            instrEl.type = 'text';
            instrEl.placeholder = 'AI assist instruction (e.g. "make it night time")';
            const assistBtn = doc.createElement('button');
            assistBtn.type = 'button';
            assistBtn.className = 'menu_button';
            assistBtn.textContent = 'AI assist';
            assistBtn.addEventListener('click', async () => {
                const instruction = instrEl.value.trim();
                if (!instruction) { notify('warning', 'Enter an assist instruction first.'); return; }
                assistBtn.disabled = true;
                abortAssist = new AbortController();
                try {
                    // engine.modifyTags keeps only the FIRST line of the reply,
                    // so the current prompt is collapsed to one line first.
                    const oneLine = promptEl.value.replace(/\s*\n+\s*/g, ', ').trim();
                    const result = await modifyTags(oneLine, instruction, { signal: abortAssist.signal });
                    if (result?.tags) promptEl.value = result.tags;
                } catch (err) {
                    if (err?.name !== 'AbortError') notify('error', `AI assist failed: ${err?.message ?? err}`);
                } finally {
                    abortAssist = null;
                    assistBtn.disabled = false;
                }
            });
            row.appendChild(instrEl);
            row.appendChild(assistBtn);
            form.appendChild(row);
        }

        const negativeEl = doc.createElement('textarea');
        negativeEl.rows = 2;
        negativeEl.value = String(negative);
        const negField = field('Negative', negativeEl);
        if (profiles?.[profileKey]?.negativeDisabled) negField.parentNode.style.display = 'none';

        const numRow = doc.createElement('div');
        numRow.className = 'ifimg-edit-params';
        form.appendChild(numRow);
        const num = (labelText, value, step = 1) => {
            const wrap = doc.createElement('label');
            wrap.className = 'ifimg-edit-field ifimg-edit-num';
            const span = doc.createElement('span');
            span.textContent = labelText;
            const input = doc.createElement('input');
            input.type = 'number';
            input.step = String(step);
            input.value = value === undefined || value === null ? '' : String(value);
            wrap.appendChild(span);
            wrap.appendChild(input);
            numRow.appendChild(wrap);
            return input;
        };
        const widthEl = num('Width', params.width, 64);
        const heightEl = num('Height', params.height, 64);
        const stepsEl = num('Steps', params.steps);
        const cfgEl = num('CFG', params.cfg, 0.5);
        const seedEl = num('Seed', params.seed ?? -1);

        const collect = () => ({
            prompt: promptEl.value,
            negative: negativeEl.value,
            params: {
                width: widthEl.value === '' ? undefined : Number(widthEl.value),
                height: heightEl.value === '' ? undefined : Number(heightEl.value),
                steps: stepsEl.value === '' ? undefined : Number(stepsEl.value),
                cfg: cfgEl.value === '' ? undefined : Number(cfgEl.value),
                seed: seedEl.value === '' ? undefined : Number(seedEl.value),
            },
        });

        // ST popup path: CONFIRM gives OK/Cancel; the OK button is relabeled
        // "Generate" via popupOptions where supported.
        let ctx = null;
        try { ctx = getContext?.(); } catch { ctx = null; }
        const popup = ctx?.callGenericPopup;
        const confirmType = ctx?.POPUP_TYPE?.CONFIRM ?? 2;
        if (typeof popup === 'function') {
            try {
                const result = await popup(form, confirmType, '', { okButton: 'Generate', cancelButton: 'Cancel' });
                abortAssist?.abort();
                return result ? collect() : null;
            } catch (err) {
                console.warn('[IF Image] callGenericPopup failed; using fallback dialog:', err?.message ?? err);
            }
        }

        // Fallback: self-built modal overlay (no ST).
        return new Promise((resolve) => {
            const overlay = doc.createElement('div');
            overlay.className = 'ifimg-lightbox'; // reuse backdrop styling
            const inner = doc.createElement('div');
            inner.className = 'ifimg-lightbox-inner ifimg-edit-inner';
            inner.addEventListener('click', (e) => e.stopPropagation());
            inner.appendChild(form);
            const buttons = doc.createElement('div');
            buttons.className = 'ifimg-lb-actions';
            const done = (value) => {
                abortAssist?.abort();
                overlay.remove();
                doc.removeEventListener('keydown', onKey);
                resolve(value);
            };
            const mkBtn = (label, handler) => {
                const b = doc.createElement('button');
                b.type = 'button';
                b.className = 'menu_button';
                b.textContent = label;
                b.addEventListener('click', handler);
                buttons.appendChild(b);
            };
            mkBtn('Generate', () => done(collect()));
            mkBtn('Cancel', () => done(null));
            inner.appendChild(buttons);
            overlay.appendChild(inner);
            const onKey = (e) => { if (e.key === 'Escape') done(null); };
            overlay.addEventListener('click', () => done(null));
            doc.addEventListener('keydown', onKey);
            (doc.body || doc).appendChild(overlay);
        });
    };
}
