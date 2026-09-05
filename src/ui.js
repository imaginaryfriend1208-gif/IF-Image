// IF Image - Drawer UI with 5 Tabs: Backends, Test Generate, Characters, Persona & Styles, Test Render.
// Template literals mounted into #extensions_settings2 by index.js.

import { NAI_MODELS } from './backends/nai.js';
import { resolveCheckpoint } from './backends/a1111.js';
import { PROFILES, PROFILE_KEYS, applyProfile } from './profiles.js';
import { getAllCharacters, saveCharacter, removeCharacter, createDefaultCharacter } from './storage/chars.js';
import { getAllPersonas, savePersona, getAllStyles, saveStyle, createDefaultPersona, createDefaultStyle } from './storage/presets.js';
import { parseTriggers } from './prompt/triggers.js';
import { assemblePrompt } from './prompt/render.js';

/**
 * @param {object} args
 * @param {object} args.settings extension_settings.IF_Image (live reference)
 * @param {() => void} args.save saveSettingsDebounced wrapper
 * @param {NaiClient} args.nai
 * @param {ComfyProxyClient} args.comfy legacy proxy client (connection 'legacy_proxy')
 * @param {A1111Client} args.a1111 AUTOMATIC1111-compatible API client (connection 'a1111')
 */
export function renderDrawer({ settings, save, nai, comfy, a1111 }) {
    const html = `
    <div class="if-image-settings">
        <div class="if-image-title">
            <h2>IF Image</h2>
            <span>v0.2.0 (Phase 1)</span>
        </div>

        <div class="if-image-tabs">
            <button class="if-image-tab menu_button active" data-if-tab="backends">Backends</button>
            <button class="if-image-tab menu_button" data-if-tab="test">Test Gen</button>
            <button class="if-image-tab menu_button" data-if-tab="chars">Characters</button>
            <button class="if-image-tab menu_button" data-if-tab="presets">Persona & Style</button>
            <button class="if-image-tab menu_button" data-if-tab="render">3-Dialect Preview</button>
        </div>

        <!-- ============ BACKENDS TAB ============ -->
        <div class="if-image-panel" data-if-panel="backends">
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
                    <label for="if_a1111_url">API base URL</label>
                    <input id="if_a1111_url" type="text" class="text_pole textarea_compact" placeholder="https://your-host.example" value="">
                </div>
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
            </div>
        </div>

        <!-- ============ TEST GEN TAB ============ -->
        <div class="if-image-panel" data-if-panel="test" style="display:none;">
            <div class="if-image-row">
                <label>Backend</label>
                <div class="if-image-radios">
                    <label><input type="radio" name="if_test_backend" value="comfy"> SD backend (connection type from Backends)</label>
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
                <label for="if_per_name">Persona Name</label>
                <input id="if_per_name" type="text" class="text_pole" value="Default User">
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
                <button id="if_per_save" class="menu_button">Save Persona</button>
            </div>

            <hr class="if-image-sep"/>

            <h3>Style Preset</h3>
            <div class="if-image-row">
                <label for="if_style_name">Style Name ({{style: Name}})</label>
                <input id="if_style_name" type="text" class="text_pole" placeholder="e.g. Cyberpunk">
            </div>
            <div class="if-image-row">
                <label for="if_style_krea">Krea Style Phrase</label>
                <input id="if_style_krea" type="text" class="text_pole" placeholder="cyberpunk aesthetic, neon lighting, 35mm film">
            </div>
            <div class="if-image-row">
                <label for="if_style_illus">Illustrious Artists / Tags</label>
                <input id="if_style_illus" type="text" class="text_pole" placeholder="retro anime, 1990s (style), neon city">
            </div>
            <div class="if-image-row">
                <button id="if_style_save" class="menu_button">Save Style</button>
            </div>
            <div id="if_presets_status" class="if-image-result"></div>
        </div>

        <!-- ============ 3-DIALECT PREVIEW TAB ============ -->
        <div class="if-image-panel" data-if-panel="render" style="display:none;">
            <h3>Test-Render (Offline Compiler)</h3>
            <div class="if-image-row">
                <label for="if_render_input">Input with triggers ($Name, $me, {{style:}}, {{dialect:}})</label>
                <textarea id="if_render_input" class="text_pole textarea_compact" rows="2" placeholder="e.g. $Lyna:back sitting at a bar, neon lights, {{style: Cyberpunk}}"></textarea>
            </div>
            <div class="if-image-row">
                <button id="if_render_btn" class="menu_button">Compile Preview</button>
            </div>

            <div id="if_render_results" style="display:flex; flex-direction:column; gap:8px; margin-top:6px;">
                <div style="background:rgba(0,0,0,0.3); padding:6px; border-radius:4px;">
                    <strong style="color:#7aa2f7;">1. Krea 2 (Prose):</strong>
                    <div id="if_render_krea" style="font-size:0.85em; font-family:monospace; margin-top:2px;">(Click Compile)</div>
                </div>
                <div style="background:rgba(0,0,0,0.3); padding:6px; border-radius:4px;">
                    <strong style="color:#bb9af7;">2. rdbt Anima (Hybrid):</strong>
                    <div id="if_render_anima" style="font-size:0.85em; font-family:monospace; margin-top:2px;">(Click Compile)</div>
                </div>
                <div style="background:rgba(0,0,0,0.3); padding:6px; border-radius:4px;">
                    <strong style="color:#7dcfff;">3. Illustrious (Booru):</strong>
                    <div id="if_render_illus" style="font-size:0.85em; font-family:monospace; margin-top:2px;">(Click Compile)</div>
                </div>
            </div>
        </div>
    </div>`;

    const root = document.createElement('div');
    root.innerHTML = html;
    const el = root.firstElementChild;

    // Element helpers
    const $ = id => el.querySelector('#' + id);

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
    a1111Url.addEventListener('change', () => {
        settings.backends.a1111.baseUrl = a1111Url.value.trim();
        invalidateA1111Discovery('Base URL changed — model list invalidated. Click Refresh Models.');
        save();
        syncTestGenVisibility();
    });
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
    let a1111Models = [];

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

    function invalidateA1111Discovery(reason) {
        a1111DiscoveryEpoch += 1;
        a1111DiscoveryController?.abort();
        a1111DiscoveryController = null;
        a1111Models = [];
        fillCheckpointSelect(a1111Checkpoint, [], '', '-- Refresh Models to load --');
        if (reason) showResult(a1111Result, reason, false);
        abortInFlightGeneration('A1111 base URL or Authentication changed — generation aborted (browser request only; a started server job may still finish).');
    }

    function fillCheckpointSelect(select, models, selectedTitle, emptyLabel) {
        select.innerHTML = `<option value="">${emptyLabel}</option>` +
            models.map(m => `<option value="${m.title}">${m.title}</option>`).join('');
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
            invalidateA1111Discovery('');
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
    a1111Test.addEventListener('click', async () => {
        a1111Test.disabled = true;
        a1111Result.textContent = 'Testing (GET options + models; nothing is written)...';
        a1111Result.classList.remove('error');
        a1111DiscoveryEpoch += 1;
        const epoch = a1111DiscoveryEpoch;
        a1111DiscoveryController = new AbortController();
        try {
            const info = await a1111.testConnection({ signal: a1111DiscoveryController.signal });
            if (epoch !== a1111DiscoveryEpoch) return; // stale: URL/auth/source changed meanwhile
            a1111Models = info.models;
            fillCheckpointSelect(a1111Checkpoint, a1111Models, settings.backends.a1111.checkpoint, '-- select a checkpoint --');
            if (!resolveCheckpoint(a1111Models, settings.backends.a1111.checkpoint)) {
                settings.backends.a1111.checkpoint = '';
                a1111Checkpoint.value = '';
                save();
            }
            const parts = [`Connected. ${a1111Models.length} checkpoint(s).`];
            parts.push(info.currentCheckpoint ? `Server default: ${info.currentCheckpoint}` : 'Server default: (none reported)');
            if (info.samplers) parts.push(`${info.samplers.length} sampler(s).`);
            if (info.samplersError) parts.push(`Samplers endpoint unavailable: ${info.samplersError}`);
            showResult(a1111Result, parts.join(' · '), false);
            syncTestGenVisibility();
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
            const models = await a1111.models({ signal: a1111DiscoveryController.signal });
            if (epoch !== a1111DiscoveryEpoch) return; // stale: URL/auth/source changed meanwhile
            a1111Models = models;
            fillCheckpointSelect(a1111Checkpoint, a1111Models, settings.backends.a1111.checkpoint, '-- select a checkpoint --');
            if (!resolveCheckpoint(a1111Models, settings.backends.a1111.checkpoint)) {
                settings.backends.a1111.checkpoint = '';
                a1111Checkpoint.value = '';
                save();
            }
            showResult(a1111Result, `${a1111Models.length} checkpoint(s) available.`, false);
            syncTestGenVisibility();
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
        syncTestGenVisibility();
    });

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
            ? models.map(m => `<option value="${m.title}">${m.title}</option>`).join('')
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
    const charSaveBtn = $('if_char_save');
    const charDelBtn = $('if_char_del');
    const charStatus = $('if_char_status');

    let currentChars = [];
    let activeCharId = null;

    async function loadCharactersList() {
        try {
            currentChars = await getAllCharacters();
            charSelect.innerHTML = '<option value="">-- New Character --</option>' +
                currentChars.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
            if (activeCharId) charSelect.value = activeCharId;
        } catch (e) {
            console.warn('[IF Image] Load characters failed:', e);
        }
    }
    loadCharactersList();

    function populateCharForm(char) {
        if (!char) {
            activeCharId = null;
            charName.value = '';
            charAliases.value = '';
            charCount.value = '1girl';
            charBooru.value = '';
            charNatural.value = '';
            charFacts.value = '';
            return;
        }
        activeCharId = char.id;
        charName.value = char.name || '';
        charAliases.value = (char.aliases || []).join(', ');
        charCount.value = char.countTag || '1girl';
        charBooru.value = char.booru || '';
        charNatural.value = char.natural || '';
        charFacts.value = char.facts || '';
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

        try {
            await saveCharacter(target);
            activeCharId = target.id;
            await loadCharactersList();
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
    const perName = $('if_per_name');
    const perPov = $('if_per_pov');
    const perBooru = $('if_per_booru');
    const perNatural = $('if_per_natural');
    const perSaveBtn = $('if_per_save');
    const styleName = $('if_style_name');
    const styleKrea = $('if_style_krea');
    const styleIllus = $('if_style_illus');
    const styleSaveBtn = $('if_style_save');
    const presetsStatus = $('if_presets_status');

    let currentPersonas = [];
    let currentStyles = [];

    async function loadPresets() {
        try {
            currentPersonas = await getAllPersonas();
            currentStyles = await getAllStyles();
            if (currentPersonas.length) {
                const p = currentPersonas[0];
                perName.value = p.name || 'Default User';
                perPov.value = p.povMode || 'auto';
                perBooru.value = p.booru || '';
                perNatural.value = p.natural || '';
            }
            if (currentStyles.length) {
                const s = currentStyles[0];
                styleName.value = s.name || '';
                styleKrea.value = s.dialectHints?.krea?.stylePhrase || '';
                styleIllus.value = s.dialectHints?.illus?.artists || '';
            }
        } catch (e) {
            console.warn('[IF Image] Presets load error:', e);
        }
    }
    loadPresets();

    perSaveBtn.addEventListener('click', async () => {
        try {
            let p = currentPersonas[0] || createDefaultPersona(perName.value.trim());
            p.name = perName.value.trim();
            p.povMode = perPov.value;
            p.booru = perBooru.value.trim();
            p.natural = perNatural.value.trim();
            await savePersona(p);
            await loadPresets();
            showResult(presetsStatus, 'Persona saved!', false);
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
            let s = currentStyles.find(x => x.name === name) || createDefaultStyle(name);
            s.name = name;
            s.dialectHints.krea.stylePhrase = styleKrea.value.trim();
            s.dialectHints.illus.artists = styleIllus.value.trim();
            await saveStyle(s);
            await loadPresets();
            showResult(presetsStatus, `Style "${name}" saved!`, false);
        } catch (e) {
            showResult(presetsStatus, e.message, true);
        }
    });

    // ================= 3-Dialect Preview Wiring =================
    const renderInput = $('if_render_input');
    const renderBtn = $('if_render_btn');
    const renderKrea = $('if_render_krea');
    const renderAnima = $('if_render_anima');
    const renderIllus = $('if_render_illus');

    renderBtn.addEventListener('click', async () => {
        const text = renderInput.value.trim();
        if (!text) return;

        try {
            const roster = await getAllCharacters();
            const styles = await getAllStyles();
            const personas = await getAllPersonas();
            const context = {
                roster,
                styles,
                defaultPersona: personas[0] || createDefaultPersona(),
            };

            const parsed = parseTriggers(text, context);

            const outKrea = assemblePrompt(parsed, 'krea', PROFILES.krea2);
            const outAnima = assemblePrompt(parsed, 'anima', PROFILES.anima);
            const outIllus = assemblePrompt(parsed, 'illus', PROFILES.illustrious);

            renderKrea.textContent = outKrea.prompt || '(empty)';
            renderAnima.textContent = outAnima.prompt || '(empty)';
            renderIllus.textContent = outIllus.prompt || '(empty)';
        } catch (err) {
            renderKrea.textContent = `Error: ${err.message}`;
        }
    });

    return el;
}
