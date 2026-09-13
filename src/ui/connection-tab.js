// IF Image - Connection tab (P5a, v2 connection-first UI).
// Block [1] Image API -> [2] Model default -> [3] LLM default.
// Reads/writes ONLY settings.connection.* (schema v2, see src/settings.js).
// Generation creds never leave this module except via the backend/llm facades.

import { escapeHtml, makeHelpers } from './shared.js';
import { formatLlmError } from '../llm/client.js';

const BACKEND_LABEL = { comfy: 'ComfyCloud (A1111-compatible)', nai: 'NovelAI' };

export function connectionTabMarkup() {
    return `
        <h3>1 · Image API</h3>
        <div class="if-image-row">
            <label for="if_conn_backend">Backend</label>
            <select id="if_conn_backend" class="text_pole">
                <option value="comfy">${BACKEND_LABEL.comfy}</option>
                <option value="nai">${BACKEND_LABEL.nai}</option>
            </select>
        </div>
        <div data-if-conn-block="comfy">
            <div class="if-image-row">
                <label for="if_conn_comfy_url">API URL</label>
                <input id="if_conn_comfy_url" class="text_pole" type="text" placeholder="https://... (st-relay or direct A1111)" />
            </div>
            <div class="if-image-row">
                <label for="if_conn_comfy_auth">Auth (key or user:pass)</label>
                <input id="if_conn_comfy_auth" class="text_pole" type="password" autocomplete="off" />
            </div>
            <div class="if-image-row">
                <button id="if_conn_comfy_connect" class="menu_button">Connect</button>
                <span id="if_conn_comfy_result" class="if-image-result"></span>
            </div>
        </div>
        <div data-if-conn-block="nai" style="display:none;">
            <div class="if-image-row">
                <label for="if_conn_nai_key">NovelAI API key</label>
                <input id="if_conn_nai_key" class="text_pole" type="password" autocomplete="off" />
            </div>
            <div class="if-image-row">
                <label for="if_nai_variety" class="checkbox_label">
                    <input id="if_nai_variety" type="checkbox">
                    <span>Variety+ (skip CFG above sigma — more varied compositions)</span>
                </label>
            </div>
            <div class="if-image-row">
                <button id="if_conn_nai_verify" class="menu_button">Verify</button>
                <span id="if_conn_image_result" class="if-image-result"></span>
            </div>
        </div>

        <hr class="if-image-sep"/>

        <h3>2 · Default model <span id="if_conn_model_badge" class="if-image-badge" style="display:none;">Default</span></h3>
        <div class="if-image-row">
            <button id="if_conn_fetch_models" class="menu_button">Fetch models</button>
            <select id="if_conn_model" class="text_pole" style="flex:1;">
                <option value="">-- Connect first, then fetch --</option>
            </select>
        </div>
        <div class="if-image-row">
            <span id="if_conn_model_result" class="if-image-result"></span>
        </div>

        <hr class="if-image-sep"/>

        <h3>3 · LLM <span class="if-image-badge">Default LLM for every task</span></h3>
        <div class="if-image-row">
            <label for="if_conn_llm_mode">Source</label>
            <select id="if_conn_llm_mode" class="text_pole">
                <option value="st_profile">SillyTavern API profile</option>
                <option value="custom">Custom OpenAI-compatible</option>
            </select>
        </div>
        <div data-if-llm-block="st_profile">
            <div class="if-image-row">
                <label for="if_conn_llm_st_profile">ST profile</label>
                <select id="if_conn_llm_st_profile" class="text_pole" style="flex:1;"></select>
            </div>
        </div>
        <div data-if-llm-block="custom" style="display:none;">
            <div class="if-image-row">
                <label for="if_conn_llm_custom_url">Base URL</label>
                <input id="if_conn_llm_custom_url" class="text_pole" type="text" placeholder="https://api.../v1" />
            </div>
            <div class="if-image-row">
                <label for="if_conn_llm_custom_key">API key</label>
                <input id="if_conn_llm_custom_key" class="text_pole" type="password" autocomplete="off" />
            </div>
            <div class="if-image-row">
                <label for="if_conn_llm_custom_model">Model</label>
                <input id="if_conn_llm_custom_model" class="text_pole" type="text" />
            </div>
        </div>
        <div class="if-image-row">
            <button id="if_conn_llm_test" class="menu_button">Test LLM</button>
            <span id="if_conn_llm_result" class="if-image-result"></span>
        </div>`;
}

/**
 * @param {{ mount: Element, settings: object, save: Function, imageBackend: object,
 *          llmClient: object, listStProfiles: Function, notify?: Function }} deps
 * @returns {{ refresh: Function }}
 */
export function mountConnectionTab({ mount, settings, save, imageBackend, llmClient, listStProfiles, notify }) {
    mount.innerHTML = connectionTabMarkup();
    const { $, showResult } = makeHelpers(mount);

    const conn = () => settings.connection;
    const ensure = () => {
        const c = conn();
        c.comfy ??= { url: '', auth: '', transport: 'st-relay', model: '', modelList: [] };
        c.nai ??= { apiKey: '', model: '', modelList: [] };
        c.llm ??= { mode: 'st_profile', stProfileId: '', custom: { baseUrl: '', apiKey: '', model: '' } };
        c.llm.custom ??= { baseUrl: '', apiKey: '', model: '' };
        return c;
    };

    const backendSel = $('if_conn_backend');
    const comfyUrl = $('if_conn_comfy_url');
    const comfyAuth = $('if_conn_comfy_auth');
    const comfyResult = $('if_conn_comfy_result');
    const naiKey = $('if_conn_nai_key');
    const naiVerify = $('if_conn_nai_verify');
    const naiResult = $('if_conn_image_result');
    const fetchBtn = $('if_conn_fetch_models');
    const modelSel = $('if_conn_model');
    const modelResult = $('if_conn_model_result');
    const modelBadge = $('if_conn_model_badge');
    const llmMode = $('if_conn_llm_mode');
    const llmProfile = $('if_conn_llm_st_profile');
    const llmUrl = $('if_conn_llm_custom_url');
    const llmKey = $('if_conn_llm_custom_key');
    const llmModel = $('if_conn_llm_custom_model');
    const llmTest = $('if_conn_llm_test');
    const llmResult = $('if_conn_llm_result');

    const abortable = () => new AbortController();

    function renderBackend() {
        const c = ensure();
        const kind = c.imageBackend === 'nai' ? 'nai' : 'comfy';
        backendSel.value = kind;
        mount.querySelectorAll('[data-if-conn-block]').forEach(b => {
            b.style.display = b.dataset.ifConnBlock === kind ? '' : 'none';
        });
        comfyUrl.value = c.comfy.url ?? '';
        comfyAuth.value = c.comfy.auth ?? '';
        naiKey.value = c.nai.apiKey ?? '';
        renderModelList();
    }

    function renderModelList() {
        const c = ensure();
        const kind = backendSel.value;
        const list = Array.isArray(c[kind]?.modelList) ? c[kind].modelList : [];
        const active = c[kind]?.model ?? '';
        modelSel.innerHTML = list.length
            ? list.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')
            : '<option value="">-- Fetch models to load --</option>';
        if (list.includes(active)) modelSel.value = active;
        modelBadge.style.display = active ? '' : 'none';
    }

    function renderLlm() {
        const c = ensure();
        llmMode.value = c.llm.mode === 'custom' ? 'custom' : 'st_profile';
        mount.querySelectorAll('[data-if-llm-block]').forEach(b => {
            b.style.display = b.dataset.ifLlmBlock === llmMode.value ? '' : 'none';
        });
        llmUrl.value = c.llm.custom.baseUrl ?? '';
        llmKey.value = c.llm.custom.apiKey ?? '';
        llmModel.value = c.llm.custom.model ?? '';
        refreshStProfiles();
    }

    function refreshStProfiles() {
        if (llmMode.value !== 'st_profile') return;
        const profiles = listStProfiles?.() ?? [];
        const activeId = ensure().llm.stProfileId ?? '';
        llmProfile.innerHTML = profiles.length
            ? profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</option>`).join('')
            : '<option value="">-- no ST API profiles saved --</option>';
        if (profiles.some(p => p.id === activeId)) llmProfile.value = activeId;
    }

    backendSel.addEventListener('change', () => {
        ensure().imageBackend = backendSel.value;
        save();
        renderBackend();
    });
    comfyUrl.addEventListener('change', () => { ensure().comfy.url = comfyUrl.value.trim(); save(); });
    comfyAuth.addEventListener('change', () => { ensure().comfy.auth = comfyAuth.value.trim(); save(); });
    naiKey.addEventListener('change', () => { ensure().nai.apiKey = naiKey.value.trim(); save(); });

    const naiVariety = $('if_nai_variety');
    if (naiVariety) {
        naiVariety.checked = Boolean(ensure().nai?.variety);
        naiVariety.addEventListener('change', () => { ensure().nai.variety = naiVariety.checked; save(); });
    }

    $('if_conn_comfy_connect').addEventListener('click', async () => {
        const controller = abortable();
        $('if_conn_comfy_connect').disabled = true;
        showResult(comfyResult, 'Connecting…', false);
        try {
            const ok = await imageBackend.getClient('comfy').testConnection({ signal: controller.signal });
            showResult(comfyResult, ok ? 'Connected.' : 'No response from the endpoint.', !ok);
            if (ok) fetchBtn.disabled = false;
        } catch (e) {
            showResult(comfyResult, e.message, true);
        } finally {
            $('if_conn_comfy_connect').disabled = false;
        }
    });

    naiVerify.addEventListener('click', async () => {
        naiVerify.disabled = true;
        showResult(naiResult, 'Verifying…', false);
        try {
            const ok = await imageBackend.verifyKey();
            showResult(naiResult, ok ? 'Key valid.' : 'Key rejected.', !ok);
        } catch (e) {
            showResult(naiResult, e.message, true);
        } finally {
            naiVerify.disabled = false;
        }
    });

    let fetchEpoch = 0;
    fetchBtn.addEventListener('click', async () => {
        const epoch = ++fetchEpoch;
        const controller = abortable();
        fetchBtn.disabled = true;
        showResult(modelResult, 'Fetching model list…', false);
        try {
            const models = await imageBackend.fetchModels({ signal: controller.signal });
            if (epoch !== fetchEpoch) return; // stale
            ensure()[backendSel.value].modelList = models;
            save();
            renderModelList();
            showResult(modelResult, `${models.length} models loaded. Pick one — it becomes the default.`, false);
        } catch (e) {
            if (epoch === fetchEpoch) showResult(modelResult, e.message, true);
        } finally {
            if (epoch === fetchEpoch) fetchBtn.disabled = false;
        }
    });

    modelSel.addEventListener('change', () => {
        const c = ensure();
        c[backendSel.value].model = modelSel.value; // switch default = new default
        save();
        modelBadge.style.display = modelSel.value ? '' : 'none';
        showResult(modelResult, modelSel.value ? `Default model: ${modelSel.value}` : '', false);
    });

    llmMode.addEventListener('change', () => {
        ensure().llm.mode = llmMode.value;
        save();
        renderLlm();
    });
    llmProfile.addEventListener('change', () => { ensure().llm.stProfileId = llmProfile.value; save(); });
    llmUrl.addEventListener('change', () => { ensure().llm.custom.baseUrl = llmUrl.value.trim(); save(); });
    llmKey.addEventListener('change', () => { ensure().llm.custom.apiKey = llmKey.value.trim(); save(); });
    llmModel.addEventListener('change', () => { ensure().llm.custom.model = llmModel.value.trim(); save(); });

    llmTest.addEventListener('click', async () => {
        llmTest.disabled = true;
        showResult(llmResult, 'Asking the LLM…', false);
        try {
            const controller = abortable();
            const reply = await llmClient.request({ type: 'image_gen', systemPrompt: '', userPrompt: 'Reply with the single word OK.', signal: controller.signal });
            const text = String(reply ?? '').trim().slice(0, 120);
            showResult(llmResult, text ? `OK — replied: ${text}` : 'Empty reply.', !text);
        } catch (e) {
            showResult(llmResult, formatLlmError(e, 'LLM test'), true);
            notify?.('llm_test_failed', e?.message ?? 'LLM test failed');
        } finally {
            llmTest.disabled = false;
        }
    });

    renderBackend();
    renderLlm();

    return {
        refresh() { renderBackend(); renderLlm(); },
    };
}
