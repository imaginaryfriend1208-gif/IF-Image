// IF Image - SillyTavern third-party image generation extension.
// Standalone: fetches NovelAI and the user's SD WebUI backends directly,
// never uses ST secrets or ST server APIs for generation.

import { getSettings, saveSettings } from './src/settings.js';
import { NaiClient } from './src/backends/nai.js';
import { ComfyProxyClient } from './src/backends/comfy.js';
import { A1111Client } from './src/backends/a1111.js';
import { renderDrawer } from './src/ui.js';
import { createMarkerRuntime } from './src/runtime/events.js';
import { event_types, eventSource } from '../../../../script.js';
import { getContext } from '../../../st-context.js';

// toastr is a page global (loaded via <script src="lib/toastr.min.js"> in index.html);
// ST extensions use it without importing it.
/* global toastr */

const settings = getSettings();

const nai = new NaiClient(() => settings.backends.nai.apiKey);
const comfy = new ComfyProxyClient({
    getBaseUrl: () => settings.backends.comfy.baseUrl,
    getUsername: () => settings.backends.comfy.username,
    getPassword: () => settings.backends.comfy.password,
});
// AUTOMATIC1111-compatible hosted API. The Authentication string is passed
// through verbatim (ST getBasicAuthHeader semantics: UTF-8 base64 of the raw
// string, no colon insertion, no Bearer fallback).
const a1111 = new A1111Client({
    getBaseUrl: () => settings.backends.a1111.baseUrl,
    getAuth: () => settings.backends.a1111.auth,
});

jQuery(async () => {
    const drawer = renderDrawer({ settings, save: saveSettings, nai, comfy, a1111 });
    $('#extensions_settings2').append(drawer);
    if (typeof toastr !== 'undefined') {
        toastr.info('IF Image loaded. Configure backends in the extensions drawer.', 'IF Image');
    }

    // Runtime marker detection (Phase 2). Read-only until the pipeline
    // (Step 2.5) consumes markers; listeners are removed on unload.
    const runtime = createMarkerRuntime({
        eventSource,
        eventTypes: event_types,
        getChatId: () => getContext().getCurrentChatId(),
        getMessage: (id) => getContext().chat?.[id],
        getMessageElement: (id) => document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`),
        isStreaming: (id) => {
            const stream = getContext().streamingProcessor;
            return Boolean(stream && !stream.isStopped && Number(stream.messageId) === id);
        },
        settings,
    });
    runtime.register();
    $(window).on('beforeunload.if_image', () => runtime.unregister());
});
