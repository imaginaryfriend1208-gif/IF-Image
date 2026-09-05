// IF Image - SillyTavern third-party image generation extension.
// Standalone: fetches NovelAI and the user's Comfy Cloud proxy directly,
// never uses ST secrets or ST server APIs for generation.

import { getSettings, saveSettings } from './src/settings.js';
import { NaiClient } from './src/backends/nai.js';
import { ComfyProxyClient } from './src/backends/comfy.js';
import { renderDrawer } from './src/ui.js';

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

jQuery(async () => {
    const drawer = renderDrawer({ settings, save: saveSettings, nai, comfy });
    $('#extensions_settings2').append(drawer);
    if (typeof toastr !== 'undefined') {
        toastr.info('IF Image loaded. Configure backends in the extensions drawer.', 'IF Image');
    }
});
