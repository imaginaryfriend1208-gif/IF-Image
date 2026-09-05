// IF Image - drawer UI. English labels only.
// Template literals; mounted into #extensions_settings2 by index.js.

import { NAI_MODELS } from './backends/nai.js';
import { PROFILES, PROFILE_KEYS, applyProfile } from './profiles.js';

/**
 * @param {object} args
 * @param {object} args.settings extension_settings.IF_Image (live reference)
 * @param {() => void} args.save saveSettingsDebounced wrapper
 * @param {NaiClient} args.nai
 * @param {ComfyProxyClient} args.comfy
 */
export function renderDrawer({ settings, save, nai, comfy }) {
    const html = `
    <div class="if-image-settings">
        <div class="if-image-title">
            <h2>IF Image</h2>
            <span>Test build 0.2.0</span>
        </div>

        <div class="if-image-tabs">
            <button class="if-image-tab menu_button" data-if-tab="backends">Backends</button>
            <button class="if-image-tab menu_button" data-if-tab="test">Test Generate</button>
        </div>

        <!-- ============ BACKENDS TAB ============ -->
        <div class="if-image-panel" data-if-panel="backends">
            <h3>NovelAI</h3>
            <div class="if-image-row">
                <label for="if_nai_key">API token (pst-...)</label>
                <input id="if_nai_key" type="password" class="text_pole textarea_compact" autocomplete="off"
                       placeholder="pst-..." value="">
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

            <h3>Comfy proxy</h3>
            <div class="if-image-row">
                <label for="if_comfy_url">Proxy URL</label>
                <input id="if_comfy_url" type="text" class="text_pole textarea_compact"
                       placeholder="http://localhost:7861" value="">
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
                <button id="if_comfy_test" class="menu_button">Test connection</button>
            </div>
            <div class="if-image-result" id="if_comfy_result"></div>
        </div>

        <!-- ============ TEST TAB ============ -->
        <div class="if-image-panel" data-if-panel="test" style="display:none;">
            <div class="if-image-row">
                <label>Backend</label>
                <div class="if-image-radios">
                    <label><input type="radio" name="if_test_backend" value="comfy"> Comfy proxy</label>
                    <label><input type="radio" name="if_test_backend" value="nai"> NovelAI</label>
                </div>
            </div>

            <div class="if-image-row" data-if-comfy-only>
                <label for="if_test_profile">Profile</label>
                <select id="if_test_profile" class="text_pole">
                    ${PROFILE_KEYS.map(k => `<option value="${k}">${PROFILES[k].label}</option>`).join('')}
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
                <button id="if_test_generate" class="menu_button">Generate</button>
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
    </div>`;

    const root = document.createElement('div');
    root.innerHTML = html;
    const el = root.firstElementChild;

    // ---- element refs ----
    const $ = id => el.querySelector('#' + id);
    const naiKey = $('if_nai_key');
    const naiModel = $('if_nai_model');
    const naiTest = $('if_nai_test');
    const naiResult = $('if_nai_result');
    const comfyUrl = $('if_comfy_url');
    const comfyUser = $('if_comfy_user');
    const comfyPass = $('if_comfy_pass');
    const comfyProfile = $('if_comfy_profile');
    const comfyTest = $('if_comfy_test');
    const comfyResult = $('if_comfy_result');
    const testProfileRow = el.querySelector('[data-if-comfy-only]');
    const testNegativeRow = el.querySelector('[data-if-nai-only]');
    const testProfile = $('if_test_profile');
    const testPrompt = $('if_test_prompt');
    const testNegative = $('if_test_negative');
    const testWidth = $('if_test_width');
    const testHeight = $('if_test_height');
    const testSteps = $('if_test_steps');
    const testCfg = $('if_test_cfg');
    const testSeed = $('if_test_seed');
    const generateBtn = $('if_test_generate');
    const errorBox = $('if_test_error');
    const outputBox = $('if_test_output');
    const imageEl = $('if_test_image');
    const captionEl = $('if_test_caption');
    const downloadEl = $('if_test_download');
    const elapsedEl = $('if_test_elapsed');

    // ---- init values from settings ----
    naiKey.value = settings.backends.nai.apiKey;
    naiModel.value = settings.backends.nai.model;
    comfyUrl.value = settings.backends.comfy.baseUrl;
    comfyUser.value = settings.backends.comfy.username;
    comfyPass.value = settings.backends.comfy.password;
    comfyProfile.value = settings.backends.comfy.profile;
    testProfile.value = settings.test.profile || settings.backends.comfy.profile;
    testPrompt.value = settings.test.prompt;
    testNegative.value = settings.test.negative;
    testWidth.value = settings.test.width;
    testHeight.value = settings.test.height;
    testSteps.value = settings.test.steps;
    testCfg.value = settings.test.cfg;
    testSeed.value = settings.test.seed;
    syncBackendRadio();

    // ---- tabs ----
    el.querySelectorAll('.if-image-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            el.querySelectorAll('.if-image-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            el.querySelectorAll('.if-image-panel').forEach(p => {
                p.style.display = p.dataset.ifPanel === btn.dataset.ifTab ? '' : 'none';
            });
        });
    });
    el.querySelector('.if-image-tab').classList.add('active');

    // ---- backends tab handlers ----
    naiKey.addEventListener('change', () => { settings.backends.nai.apiKey = naiKey.value.trim(); save(); });
    naiModel.addEventListener('change', () => { settings.backends.nai.model = naiModel.value; save(); });
    comfyUrl.addEventListener('change', () => { settings.backends.comfy.baseUrl = comfyUrl.value.trim(); save(); });
    comfyUser.addEventListener('change', () => { settings.backends.comfy.username = comfyUser.value; save(); });
    comfyPass.addEventListener('change', () => { settings.backends.comfy.password = comfyPass.value; save(); });
    comfyProfile.addEventListener('change', () => { settings.backends.comfy.profile = comfyProfile.value; save(); });

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
            showResult(naiResult,
                `Tier: ${info.tier} · active: ${info.active ? 'yes' : 'no'} · Anlas: ${info.anlas}` +
                (info.unlimitedImageGeneration ? ' · unlimited image generation' : ''), false);
        } catch (error) {
            showResult(naiResult, error.message, true);
        } finally {
            naiTest.disabled = false;
        }
    });

    // Family -> proxy model title map, refreshed from the proxy when possible.
    // The proxy's txt2img `model` field matches model id / title / checkpoint file
    // name, NOT the family name, so profiles must resolve to a real model entry.
    let proxyModelsByFamily = {};
    async function refreshProxyModels() {
        try {
            const models = await comfy.models();
            proxyModelsByFamily = {};
            const status = await comfy.status();
            for (const entry of (status.settings?.models ?? [])) {
                if (entry.enabled && entry.family) {
                    // Prefer the sd-models title (matches findModel by title).
                    const match = models.find(m => m.filename === entry.checkpointFile);
                    proxyModelsByFamily[entry.family] = match?.title ?? entry.id;
                }
            }
        } catch { /* keep current mapping */ }
    }

    comfyTest.addEventListener('click', async () => {
        comfyTest.disabled = true;
        comfyResult.textContent = 'Checking...';
        comfyResult.classList.remove('error');
        try {
            const ping = await comfy.ping();
            let line = `Proxy OK (${ping.service ?? 'unknown service'})`;
            try {
                const status = await comfy.status();
                const families = (status.settings?.models ?? [])
                    .filter(m => m.enabled)
                    .map(m => m.family);
                const unique = [...new Set(families)];
                line += ` · cloud key: ${status.cloudConfigured ? 'configured' : 'MISSING'}` +
                    ` · profiles: ${unique.join('/') || 'none'}` +
                    ` · characters: ${status.characterCount ?? 0}`;
                await refreshProxyModels();
            } catch (statusError) {
                line += ` · status failed: ${statusError.message}`;
            }
            showResult(comfyResult, line, false);
        } catch (error) {
            showResult(comfyResult, error.message, true);
        } finally {
            comfyTest.disabled = false;
        }
    });

    // ---- test tab handlers ----
    function syncBackendRadio() {
        el.querySelectorAll('input[name="if_test_backend"]').forEach(r => {
            r.checked = r.value === settings.test.backend;
        });
        const isComfy = settings.test.backend === 'comfy';
        testProfileRow.style.display = isComfy ? '' : 'none';
        // Negative prompt: used by NovelAI and by Comfy families above CFG 1.
        const profile = PROFILES[settings.test.profile ?? settings.backends.comfy.profile];
        const comfyUsesNegative = !profile || !profile.negativeDisabled;
        testNegativeRow.style.display = (isComfy && !comfyUsesNegative) ? 'none' : '';
    }

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
        refreshTestForm();
        syncBackendRadio();
        save();
    });

    function refreshTestForm() {
        testPrompt.value = settings.test.prompt;
        testNegative.value = settings.test.negative;
        testWidth.value = settings.test.width;
        testHeight.value = settings.test.height;
        testSteps.value = settings.test.steps;
        testCfg.value = settings.test.cfg;
        testSeed.value = settings.test.seed;
    }

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

    let lastObjectUrl = null;
    function showImage(url, revoke) {
        if (lastObjectUrl) {
            URL.revokeObjectURL(lastObjectUrl);
            lastObjectUrl = null;
        }
        if (revoke) lastObjectUrl = url;
        imageEl.src = url;
        downloadEl.href = url;
        outputBox.style.display = '';
    }

    function showError(text) {
        errorBox.textContent = text;
        errorBox.style.display = '';
        errorBox.classList.add('error');
    }

    function hideOutput() {
        errorBox.style.display = 'none';
        outputBox.style.display = 'none';
    }

    generateBtn.addEventListener('click', async () => {
        hideOutput();
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating...';
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
                });
                const url = URL.createObjectURL(blob);
                showImage(url, true);
                captionEl.textContent =
                    `NovelAI · ${settings.backends.nai.model} · ` +
                    `${settings.test.width}x${settings.test.height} · steps ${settings.test.steps} · cfg ${settings.test.cfg}`;
            } else {
                const family = settings.test.profile ?? settings.backends.comfy.profile;
                let modelTitle = proxyModelsByFamily[family];
                if (!modelTitle) {
                    // Mapping not loaded yet (or new family): fetch it before generating.
                    await refreshProxyModels();
                    modelTitle = proxyModelsByFamily[family];
                }
                if (!modelTitle) {
                    throw new Error(`Could not resolve a proxy model for the "${family}" profile. Check that the proxy has an enabled model of that family (Backends tab -> Test connection).`);
                }
                const result = await comfy.txt2img({
                    prompt: settings.test.prompt,
                    negative_prompt: settings.test.negative,
                    model: modelTitle,
                    seed: settings.test.seed,
                    width: settings.test.width,
                    height: settings.test.height,
                    steps: settings.test.steps,
                    cfg_scale: settings.test.cfg,
                });
                showImage(result.dataUrl, true);
                const info = result.info ?? {};
                captionEl.textContent =
                    `Comfy proxy · ${info.model ?? family} · ` +
                    `${info.width ?? settings.test.width}x${info.height ?? settings.test.height} · ` +
                    `steps ${settings.test.steps} · cfg ${settings.test.cfg}` +
                    (info.seed !== undefined ? ` · seed ${info.seed}` : '');
            }
            elapsedEl.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
        } catch (error) {
            showError(error.message);
        } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate';
        }
    });

    return el;
}
