// plugins/cohere-transcribe/web/index.js — Cohere Transcribe settings panel
// Exposes the big "Activate as STT Provider" toggle, wake word toggle,
// live model status, and a 5-second mic test. Also hosts the legacy
// drag-and-drop file transcription UI for voice-clone prep.

import { registerPluginSettings } from '/static/shared/plugin-registry.js';

const PLUGIN = 'cohere-transcribe';
const API = `/api/plugin/${PLUGIN}`;
const CSRF = () => document.querySelector('meta[name="csrf-token"]')?.content || '';
const PROVIDER_KEY = 'cohere_transcribe';
const FALLBACK_PROVIDER = 'faster_whisper';

// ── Escape helper ──
function esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── API helpers ──
async function getSetting(key) {
    try {
        const resp = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
            headers: { 'X-CSRF-Token': CSRF() }
        });
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        console.warn(`[cohere-transcribe] getSetting(${key}) failed:`, e);
        return null;
    }
}

async function putSetting(key, value, persist = true) {
    const resp = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF() },
        body: JSON.stringify({ value, persist })
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || err.error || `HTTP ${resp.status}`);
    }
    return await resp.json();
}

async function getModelStatus() {
    try {
        const resp = await fetch(`${API}/status`, { headers: { 'X-CSRF-Token': CSRF() } });
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        return null;
    }
}

registerPluginSettings({
    id: PLUGIN,
    name: 'Cohere Transcribe',
    icon: '\uD83C\uDFA7',
    helpText: 'Turn Sapphire\u2019s ears on. Activate Cohere Transcribe as your speech-to-text provider so personas can hear you via the wake word.',

    async render(container, _settings) {
        container.innerHTML = `
            <div class="ct-lab">
                <!-- ═══ Activation Section ═══ -->
                <div class="ct-card">
                    <div class="ct-card-header">
                        <span class="ct-card-icon">\uD83C\uDF99\uFE0F</span>
                        <h3>Speech-to-Text Provider</h3>
                    </div>
                    <p class="ct-desc">
                        Activate Cohere Transcribe as the system-wide STT engine. This powers the
                        wake-word voice pipeline \u2014 your speech gets transcribed and sent to the
                        active persona as if you typed it.
                    </p>

                    <div class="ct-toggle-row">
                        <label class="ct-switch">
                            <input type="checkbox" id="ct-activate-toggle" />
                            <span class="ct-slider"></span>
                        </label>
                        <div class="ct-toggle-info">
                            <div class="ct-toggle-label" id="ct-activate-label">Activate as STT Provider</div>
                            <div class="ct-toggle-sub" id="ct-activate-status">Checking current status\u2026</div>
                        </div>
                    </div>

                    <div class="ct-note" id="ct-activate-note"></div>
                </div>

                <!-- ═══ Wake Word Section ═══ -->
                <div class="ct-card">
                    <div class="ct-card-header">
                        <span class="ct-card-icon">\uD83D\uDC42</span>
                        <h3>Wake Word</h3>
                    </div>
                    <p class="ct-desc">
                        Sapphire listens for a wake word (default: \u201CHey Sapphire\u201D). When detected,
                        it records your sentence, runs it through the active STT provider, and routes
                        the transcription to the current persona.
                    </p>

                    <div class="ct-toggle-row">
                        <label class="ct-switch">
                            <input type="checkbox" id="ct-wake-toggle" />
                            <span class="ct-slider"></span>
                        </label>
                        <div class="ct-toggle-info">
                            <div class="ct-toggle-label">Wake word detection</div>
                            <div class="ct-toggle-sub" id="ct-wake-status">Checking\u2026</div>
                        </div>
                    </div>

                    <div class="ct-pipeline-steps">
                        <div class="ct-step"><span class="ct-step-num">1</span> Say the wake word</div>
                        <div class="ct-step"><span class="ct-step-num">2</span> Hear the activation tone</div>
                        <div class="ct-step"><span class="ct-step-num">3</span> Speak your message</div>
                        <div class="ct-step"><span class="ct-step-num">4</span> Transcription is sent to the active persona</div>
                    </div>
                </div>

                <!-- ═══ Mic Test Section ═══ -->
                <div class="ct-card">
                    <div class="ct-card-header">
                        <span class="ct-card-icon">\uD83C\uDFA4</span>
                        <h3>Microphone Test</h3>
                    </div>
                    <p class="ct-desc">
                        Record 5 seconds of audio in your browser and transcribe it here.
                        Confirms Cohere is loading correctly and gauges accuracy on your mic.
                    </p>

                    <div class="ct-mic-row">
                        <button class="ct-btn ct-btn-primary" id="ct-mic-btn">
                            <span id="ct-mic-btn-label">\uD83C\uDFA4 Start 5s Recording</span>
                        </button>
                        <span class="ct-mic-timer" id="ct-mic-timer"></span>
                    </div>

                    <div class="ct-result" id="ct-mic-result" style="display:none;">
                        <div class="ct-result-label">Transcription:</div>
                        <div class="ct-result-text" id="ct-mic-text"></div>
                    </div>
                </div>

                <!-- ═══ Mic Calibration Section ═══ -->
                <div class="ct-card">
                    <div class="ct-card-header">
                        <span class="ct-card-icon">\uD83C\uDF9A\uFE0F</span>
                        <h3>Mic Calibration</h3>
                    </div>
                    <p class="ct-desc">
                        Live level monitor for tuning the voice-activity detector. If the VAD never cuts off
                        and your recordings hit the 30-second max, background noise is raising the adaptive
                        threshold above silence. Watch the meter, set a threshold, save.
                    </p>

                    <div class="ct-mic-row">
                        <button class="ct-btn ct-btn-primary" id="ct-cal-start">
                            <span id="ct-cal-start-label">\u25B6\uFE0F Start Monitor</span>
                        </button>
                        <button class="ct-btn" id="ct-cal-auto" disabled title="Sample 3s of silence and set threshold">
                            \uD83C\uDFAF Auto-Calibrate (3s silence)
                        </button>
                        <span class="ct-cal-hint" id="ct-cal-hint"></span>
                    </div>

                    <div class="ct-cal-meter-wrap">
                        <canvas id="ct-cal-canvas" width="820" height="110"></canvas>
                        <div class="ct-cal-legend">
                            <span><span class="ct-cal-dot" style="background:#4ea3ff"></span>Level</span>
                            <span><span class="ct-cal-dot" style="background:#ffcb3a"></span>Fixed floor (SILENCE_THRESHOLD)</span>
                            <span><span class="ct-cal-dot" style="background:#ff5a5a"></span>Adaptive threshold (live)</span>
                        </div>
                        <div class="ct-cal-readout" id="ct-cal-readout">Monitor not running.</div>
                    </div>

                    <div class="ct-cal-grid">
                        <label class="ct-cal-field">
                            <span class="ct-cal-key">Silence threshold (floor)</span>
                            <input id="ct-cal-threshold" type="number" step="0.0001" min="0" max="0.1" />
                            <span class="ct-cal-sub">Default 0.0025 \u2014 chunks below this are silent</span>
                        </label>
                        <label class="ct-cal-field">
                            <span class="ct-cal-key">Noise multiplier</span>
                            <input id="ct-cal-multiplier" type="number" step="0.05" min="1.0" max="4.0" />
                            <span class="ct-cal-sub">Default 1.1 \u2014 raise in noisy rooms (try 1.5\u20132.0)</span>
                        </label>
                        <label class="ct-cal-field">
                            <span class="ct-cal-key">Background percentile</span>
                            <input id="ct-cal-percentile" type="number" step="1" min="5" max="95" />
                            <span class="ct-cal-sub">Default 32 \u2014 lower = less transient drift</span>
                        </label>
                        <label class="ct-cal-field">
                            <span class="ct-cal-key">Silence duration (s)</span>
                            <input id="ct-cal-duration" type="number" step="0.1" min="0.3" max="10" />
                            <span class="ct-cal-sub">Default 1.0 \u2014 seconds of silence to end recording</span>
                        </label>
                    </div>

                    <div class="ct-cal-actions">
                        <button class="ct-btn ct-btn-primary" id="ct-cal-save">Save Calibration</button>
                        <button class="ct-btn" id="ct-cal-reset">Reset to Defaults</button>
                        <span class="ct-cal-save-hint" id="ct-cal-save-hint"></span>
                    </div>
                </div>

                <!-- ═══ Model Status Section ═══ -->
                <div class="ct-card">
                    <div class="ct-card-header">
                        <span class="ct-card-icon">\uD83D\uDCCA</span>
                        <h3>Model Status</h3>
                        <button class="ct-btn ct-btn-sm" id="ct-refresh-status" title="Refresh status">\u21BB</button>
                    </div>

                    <div class="ct-status-grid" id="ct-status-grid">
                        <div class="ct-status-row">
                            <span class="ct-status-key">Model</span>
                            <span class="ct-status-val" id="ct-status-model">\u2026</span>
                        </div>
                        <div class="ct-status-row">
                            <span class="ct-status-key">Device</span>
                            <span class="ct-status-val" id="ct-status-device">\u2026</span>
                        </div>
                        <div class="ct-status-row">
                            <span class="ct-status-key">VRAM State</span>
                            <span class="ct-status-val" id="ct-status-loaded">\u2026</span>
                        </div>
                        <div class="ct-status-row">
                            <span class="ct-status-key">Available</span>
                            <span class="ct-status-val" id="ct-status-available">\u2026</span>
                        </div>
                    </div>

                    <p class="ct-hint">
                        Model loads on first transcription (\u223C10\u201320s) and auto-unloads after
                        60s of inactivity to free VRAM for LM Studio.
                    </p>
                </div>

                <!-- ═══ Corrections Section ═══ -->
                <div class="ct-card">
                    <div class="ct-card-header">
                        <span class="ct-card-icon">\u270F\uFE0F</span>
                        <h3>Transcription Corrections</h3>
                    </div>
                    <p class="ct-desc">
                        Fix common mistranscriptions before they reach the LLM. Great for persona
                        names the ASR routinely gets wrong (\u201CLexie\u201D \u2192 \u201CLexi\u201D,
                        \u201CDawna\u201D \u2192 \u201CDonna\u201D) or uncommon proper nouns.
                        Rules run as a post_stt hook on every transcription.
                    </p>

                    <div class="ct-toggle-row">
                        <label class="ct-switch">
                            <input type="checkbox" id="ct-corr-enabled" />
                            <span class="ct-slider"></span>
                        </label>
                        <div class="ct-toggle-info">
                            <div class="ct-toggle-label">Apply corrections</div>
                            <div class="ct-toggle-sub" id="ct-corr-status">Loading\u2026</div>
                        </div>
                    </div>

                    <div class="ct-corr-list" id="ct-corr-list"></div>

                    <div class="ct-corr-actions">
                        <button class="ct-btn" id="ct-corr-add">+ Add Rule</button>
                        <button class="ct-btn ct-btn-primary" id="ct-corr-save">Save Rules</button>
                        <span class="ct-corr-hint" id="ct-corr-hint"></span>
                    </div>
                </div>

                <!-- ═══ File Transcribe Section ═══ -->
                <div class="ct-card">
                    <div class="ct-card-header">
                        <span class="ct-card-icon">\uD83D\uDCC2</span>
                        <h3>File Transcription</h3>
                    </div>
                    <p class="ct-desc">
                        Drop an audio file here to transcribe it locally \u2014 useful for
                        voice-clone reference audio or long-form dictation.
                    </p>

                    <div class="ct-dropzone" id="ct-dropzone">
                        <div class="ct-drop-icon">\uD83C\uDFA7</div>
                        <div class="ct-drop-title">Drag &amp; drop an audio file</div>
                        <div class="ct-drop-sub">or click to browse \u2014 WAV, MP3, FLAC, OGG, M4A, WebM</div>
                        <input type="file" id="ct-file-input"
                               accept=".wav,.mp3,.flac,.ogg,.m4a,.wma,.aac,.opus,.webm" />
                    </div>

                    <div class="ct-file-status" id="ct-file-status" style="display:none;"></div>

                    <div class="ct-result" id="ct-file-result" style="display:none;">
                        <div class="ct-result-header">
                            <span class="ct-result-meta" id="ct-file-meta"></span>
                            <button class="ct-btn ct-btn-sm" id="ct-file-copy">Copy</button>
                        </div>
                        <textarea class="ct-result-textarea" id="ct-file-text" readonly></textarea>
                    </div>
                </div>
            </div>
        `;

        // ── Element refs ──
        const activateToggle = container.querySelector('#ct-activate-toggle');
        const activateLabel  = container.querySelector('#ct-activate-label');
        const activateStatus = container.querySelector('#ct-activate-status');
        const activateNote   = container.querySelector('#ct-activate-note');

        const wakeToggle = container.querySelector('#ct-wake-toggle');
        const wakeStatus = container.querySelector('#ct-wake-status');

        const micBtn       = container.querySelector('#ct-mic-btn');
        const micBtnLabel  = container.querySelector('#ct-mic-btn-label');
        const micTimer     = container.querySelector('#ct-mic-timer');
        const micResult    = container.querySelector('#ct-mic-result');
        const micText      = container.querySelector('#ct-mic-text');

        const statusModel     = container.querySelector('#ct-status-model');
        const statusDevice    = container.querySelector('#ct-status-device');
        const statusLoaded    = container.querySelector('#ct-status-loaded');
        const statusAvailable = container.querySelector('#ct-status-available');
        const refreshStatus   = container.querySelector('#ct-refresh-status');

        const corrEnabled = container.querySelector('#ct-corr-enabled');
        const corrStatus  = container.querySelector('#ct-corr-status');
        const corrList    = container.querySelector('#ct-corr-list');
        const corrAdd     = container.querySelector('#ct-corr-add');
        const corrSave    = container.querySelector('#ct-corr-save');
        const corrHint    = container.querySelector('#ct-corr-hint');

        const dropzone   = container.querySelector('#ct-dropzone');
        const fileInput  = container.querySelector('#ct-file-input');
        const fileStatus = container.querySelector('#ct-file-status');
        const fileResult = container.querySelector('#ct-file-result');
        const fileMeta   = container.querySelector('#ct-file-meta');
        const fileText   = container.querySelector('#ct-file-text');
        const fileCopy   = container.querySelector('#ct-file-copy');

        // Track previous STT provider so we can restore it on toggle off
        let _previousProvider = FALLBACK_PROVIDER;

        // ═══ Activation toggle ═══
        async function refreshActivationState() {
            const cur = await getSetting('STT_PROVIDER');
            const currentProvider = cur?.value || 'none';
            const isActive = currentProvider === PROVIDER_KEY;
            activateToggle.checked = isActive;

            if (isActive) {
                activateLabel.textContent = 'Cohere Transcribe is active';
                activateStatus.textContent = 'Sapphire is using Cohere for all speech-to-text';
                activateStatus.className = 'ct-toggle-sub ct-status-active';
                activateNote.textContent = '';
            } else {
                activateLabel.textContent = 'Activate as STT Provider';
                activateStatus.textContent = `Currently active: ${currentProvider}`;
                activateStatus.className = 'ct-toggle-sub ct-status-inactive';

                if (currentProvider && currentProvider !== 'none' && currentProvider !== PROVIDER_KEY) {
                    _previousProvider = currentProvider;
                    activateNote.textContent = `Toggling off will revert to "${currentProvider}".`;
                } else {
                    activateNote.textContent = 'No other provider active \u2014 toggling off disables STT entirely.';
                }
            }
        }

        activateToggle.addEventListener('change', async () => {
            const wantActive = activateToggle.checked;
            activateToggle.disabled = true;
            activateStatus.textContent = wantActive
                ? 'Activating Cohere Transcribe\u2026'
                : 'Reverting to previous provider\u2026';

            try {
                const target = wantActive ? PROVIDER_KEY : _previousProvider;
                await putSetting('STT_PROVIDER', target);
                await refreshActivationState();
                await refreshModelStatus();
            } catch (e) {
                activateStatus.textContent = `Error: ${e.message}`;
                activateStatus.className = 'ct-toggle-sub ct-status-error';
                activateToggle.checked = !wantActive;
            } finally {
                activateToggle.disabled = false;
            }
        });

        // ═══ Wake word toggle ═══
        async function refreshWakeState() {
            const cur = await getSetting('WAKE_WORD_ENABLED');
            const on = cur?.value === true;
            wakeToggle.checked = on;
            wakeStatus.textContent = on
                ? 'Listening for the wake word'
                : 'Off \u2014 no voice input unless you use the mic button';
            wakeStatus.className = on
                ? 'ct-toggle-sub ct-status-active'
                : 'ct-toggle-sub ct-status-inactive';
        }

        wakeToggle.addEventListener('change', async () => {
            const want = wakeToggle.checked;
            wakeToggle.disabled = true;
            wakeStatus.textContent = want ? 'Enabling\u2026' : 'Disabling\u2026';
            try {
                await putSetting('WAKE_WORD_ENABLED', want);
                await refreshWakeState();
            } catch (e) {
                wakeStatus.textContent = `Error: ${e.message}`;
                wakeStatus.className = 'ct-toggle-sub ct-status-error';
                wakeToggle.checked = !want;
            } finally {
                wakeToggle.disabled = false;
            }
        });

        // ═══ Model status ═══
        async function refreshModelStatus() {
            const status = await getModelStatus();
            if (!status) {
                statusModel.textContent = 'unavailable';
                statusDevice.textContent = '\u2014';
                statusLoaded.textContent = '\u2014';
                statusAvailable.textContent = 'no';
                statusAvailable.className = 'ct-status-val ct-status-error';
                return;
            }

            statusModel.textContent = status.model || '\u2014';
            statusDevice.textContent = status.device || '\u2014';

            if (status.loaded) {
                statusLoaded.innerHTML = '<span class="ct-badge ct-badge-active">Loaded in VRAM</span>';
            } else {
                statusLoaded.innerHTML = '<span class="ct-badge ct-badge-idle">Idle (auto-loads on use)</span>';
            }

            if (status.available) {
                statusAvailable.innerHTML = '<span class="ct-badge ct-badge-active">Ready</span>';
            } else {
                statusAvailable.innerHTML = `<span class="ct-badge ct-badge-error">Not ready${status.error ? ': ' + esc(status.error) : ''}</span>`;
            }
        }

        refreshStatus.addEventListener('click', async () => {
            refreshStatus.disabled = true;
            refreshStatus.textContent = '\u2026';
            try { await refreshModelStatus(); }
            finally {
                refreshStatus.disabled = false;
                refreshStatus.innerHTML = '\u21BB';
            }
        });

        // ═══ Mic test (MediaRecorder API) ═══
        let _recording = false;
        let _mediaRecorder = null;

        micBtn.addEventListener('click', async () => {
            if (_recording) return;
            micResult.style.display = 'none';
            micText.textContent = '';

            if (!navigator.mediaDevices?.getUserMedia) {
                micTimer.textContent = 'Browser does not support mic recording';
                return;
            }

            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (e) {
                micTimer.textContent = `Mic access denied: ${e.message}`;
                return;
            }

            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : MediaRecorder.isTypeSupported('audio/webm')
                ? 'audio/webm'
                : '';
            const chunks = [];

            try {
                _mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
            } catch (e) {
                stream.getTracks().forEach(t => t.stop());
                micTimer.textContent = `Recorder init failed: ${e.message}`;
                return;
            }

            _mediaRecorder.addEventListener('dataavailable', (e) => {
                if (e.data && e.data.size > 0) chunks.push(e.data);
            });

            _mediaRecorder.addEventListener('stop', async () => {
                stream.getTracks().forEach(t => t.stop());
                _recording = false;
                micBtn.disabled = false;
                micBtnLabel.textContent = '\uD83C\uDFA4 Start 5s Recording';
                micTimer.textContent = 'Transcribing\u2026';

                const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
                const ext = mimeType.includes('webm') ? 'webm' : 'wav';
                const form = new FormData();
                form.append('file', blob, `mic_test.${ext}`);

                try {
                    const resp = await fetch(`${API}/transcribe`, {
                        method: 'POST',
                        headers: { 'X-CSRF-Token': CSRF() },
                        body: form
                    });
                    const data = await resp.json();
                    if (data.error) {
                        micTimer.textContent = '';
                        micResult.style.display = 'block';
                        micText.textContent = `Error: ${data.error}`;
                        micText.className = 'ct-result-text ct-status-error';
                    } else {
                        micTimer.textContent = `${data.characters || 0} chars transcribed`;
                        micResult.style.display = 'block';
                        micText.textContent = data.text || '(no speech detected)';
                        micText.className = 'ct-result-text';
                    }
                    // Refresh status so "Loaded in VRAM" updates
                    refreshModelStatus();
                } catch (e) {
                    micTimer.textContent = '';
                    micResult.style.display = 'block';
                    micText.textContent = `Network error: ${e.message}`;
                    micText.className = 'ct-result-text ct-status-error';
                }
            });

            // Start recording
            _recording = true;
            micBtn.disabled = true;
            _mediaRecorder.start();
            let remaining = 5;
            micBtnLabel.textContent = '\uD83D\uDD34 Recording\u2026';
            micTimer.textContent = `${remaining}s`;
            const tick = setInterval(() => {
                remaining -= 1;
                if (remaining <= 0) {
                    clearInterval(tick);
                    try { _mediaRecorder.stop(); } catch {}
                } else {
                    micTimer.textContent = `${remaining}s`;
                }
            }, 1000);
        });

        // ═══ Mic Calibration ═══
        // Live level meter + threshold tuner. Mirrors the Python recorder's
        // math: level = max(abs(int16 / 32768)) per chunk, adaptive threshold =
        // max(SILENCE_THRESHOLD, percentile(history, BACKGROUND_PERCENTILE) *
        // NOISE_MULTIPLIER). We replicate that in-browser so the user can see
        // what the recorder would see.
        const calDefaults = {
            RECORDER_SILENCE_THRESHOLD: 0.0025,
            RECORDER_NOISE_MULTIPLIER: 1.1,
            RECORDER_BACKGROUND_PERCENTILE: 32,
            RECORDER_SILENCE_DURATION: 1.0,
            RECORDER_LEVEL_HISTORY_SIZE: 15,
        };

        const calStartBtn   = container.querySelector('#ct-cal-start');
        const calStartLabel = container.querySelector('#ct-cal-start-label');
        const calAutoBtn    = container.querySelector('#ct-cal-auto');
        const calHint       = container.querySelector('#ct-cal-hint');
        const calCanvas     = container.querySelector('#ct-cal-canvas');
        const calReadout    = container.querySelector('#ct-cal-readout');
        const calThreshold  = container.querySelector('#ct-cal-threshold');
        const calMultiplier = container.querySelector('#ct-cal-multiplier');
        const calPercentile = container.querySelector('#ct-cal-percentile');
        const calDuration   = container.querySelector('#ct-cal-duration');
        const calSaveBtn    = container.querySelector('#ct-cal-save');
        const calResetBtn   = container.querySelector('#ct-cal-reset');
        const calSaveHint   = container.querySelector('#ct-cal-save-hint');

        const calCtx = calCanvas.getContext('2d');
        const CAL_SCALE_MAX = 0.1;  // linear scale; anything >0.1 is clearly speech

        let _calStream = null;
        let _calAudioCtx = null;
        let _calAnalyser = null;
        let _calRaf = null;
        let _calLevelHistory = [];
        let _calCurrentLevel = 0;
        let _calCurrentAdaptive = 0;
        let _calAutoCalibrating = false;
        let _calAutoSamples = null;

        function percentile(arr, p) {
            if (!arr.length) return 0;
            const sorted = [...arr].sort((a, b) => a - b);
            const idx = Math.max(0, Math.min(sorted.length - 1,
                Math.floor((p / 100) * (sorted.length - 1))));
            return sorted[idx];
        }

        function computeAdaptive(levelHistory) {
            const threshold = parseFloat(calThreshold.value) || calDefaults.RECORDER_SILENCE_THRESHOLD;
            const multiplier = parseFloat(calMultiplier.value) || calDefaults.RECORDER_NOISE_MULTIPLIER;
            const pct = parseFloat(calPercentile.value) || calDefaults.RECORDER_BACKGROUND_PERCENTILE;
            if (!levelHistory.length) return threshold;
            const bg = percentile(levelHistory, pct);
            return Math.max(threshold, bg * multiplier);
        }

        function drawMeter() {
            const W = calCanvas.width;
            const H = calCanvas.height;
            calCtx.clearRect(0, 0, W, H);

            // Background strip
            calCtx.fillStyle = 'rgba(255,255,255,0.04)';
            calCtx.fillRect(0, H - 50, W, 30);

            // Scale ticks
            calCtx.fillStyle = 'rgba(255,255,255,0.35)';
            calCtx.font = '11px system-ui, sans-serif';
            for (let i = 0; i <= 10; i++) {
                const x = (i / 10) * W;
                const tick = (CAL_SCALE_MAX * i / 10).toFixed(3);
                calCtx.fillRect(x - 0.5, H - 14, 1, 6);
                calCtx.fillText(tick, Math.min(W - 30, x + 2), H - 2);
            }

            // Level bar (clamped to scale max for display)
            const disp = Math.min(_calCurrentLevel, CAL_SCALE_MAX);
            const barW = (disp / CAL_SCALE_MAX) * W;
            const overrun = _calCurrentLevel > CAL_SCALE_MAX;
            const grad = calCtx.createLinearGradient(0, 0, W, 0);
            grad.addColorStop(0, '#2d7cd1');
            grad.addColorStop(0.5, '#4ea3ff');
            grad.addColorStop(1, overrun ? '#ff7a3a' : '#6dd0ff');
            calCtx.fillStyle = grad;
            calCtx.fillRect(0, H - 50, barW, 30);

            // Fixed floor line (SILENCE_THRESHOLD)
            const fixed = parseFloat(calThreshold.value) || calDefaults.RECORDER_SILENCE_THRESHOLD;
            const fixedX = Math.min(W, (fixed / CAL_SCALE_MAX) * W);
            calCtx.strokeStyle = '#ffcb3a';
            calCtx.lineWidth = 2;
            calCtx.setLineDash([4, 3]);
            calCtx.beginPath();
            calCtx.moveTo(fixedX, H - 60);
            calCtx.lineTo(fixedX, H - 10);
            calCtx.stroke();
            calCtx.setLineDash([]);

            // Adaptive threshold line (live)
            const adaptive = _calCurrentAdaptive;
            const adX = Math.min(W, (adaptive / CAL_SCALE_MAX) * W);
            calCtx.strokeStyle = '#ff5a5a';
            calCtx.lineWidth = 2;
            calCtx.beginPath();
            calCtx.moveTo(adX, H - 65);
            calCtx.lineTo(adX, H - 15);
            calCtx.stroke();

            // "Silent now?" indicator top-right
            const isSilent = _calCurrentLevel < adaptive;
            calCtx.fillStyle = isSilent ? '#54d16e' : '#ff7a5a';
            calCtx.beginPath();
            calCtx.arc(W - 14, 14, 7, 0, Math.PI * 2);
            calCtx.fill();
            calCtx.fillStyle = 'rgba(255,255,255,0.8)';
            calCtx.font = '11px system-ui, sans-serif';
            calCtx.textAlign = 'right';
            calCtx.fillText(isSilent ? 'silent' : 'speech', W - 26, 18);
            calCtx.textAlign = 'left';
        }

        function renderReadout() {
            const fixed = parseFloat(calThreshold.value) || 0;
            calReadout.innerHTML = `
                <span>Level: <strong>${_calCurrentLevel.toFixed(4)}</strong></span>
                <span>Adaptive: <strong>${_calCurrentAdaptive.toFixed(4)}</strong></span>
                <span>Floor: <strong>${fixed.toFixed(4)}</strong></span>
                <span>History: <strong>${_calLevelHistory.length}</strong></span>
            `;
        }

        function calTick() {
            if (!_calAnalyser) return;
            const buf = new Float32Array(_calAnalyser.fftSize);
            _calAnalyser.getFloatTimeDomainData(buf);
            let peak = 0;
            for (let i = 0; i < buf.length; i++) {
                const a = Math.abs(buf[i]);
                if (a > peak) peak = a;
            }
            _calCurrentLevel = peak;
            _calLevelHistory.push(peak);
            if (_calLevelHistory.length > calDefaults.RECORDER_LEVEL_HISTORY_SIZE) {
                _calLevelHistory.shift();
            }
            _calCurrentAdaptive = computeAdaptive(_calLevelHistory);

            if (_calAutoCalibrating && _calAutoSamples) {
                _calAutoSamples.push(peak);
            }

            drawMeter();
            renderReadout();
            _calRaf = requestAnimationFrame(calTick);
        }

        async function startMonitor() {
            if (_calStream) return;
            calHint.textContent = 'Requesting mic\u2026';
            try {
                _calStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                    }
                });
            } catch (e) {
                calHint.textContent = `Mic denied: ${e.message}`;
                return;
            }
            _calAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const src = _calAudioCtx.createMediaStreamSource(_calStream);
            _calAnalyser = _calAudioCtx.createAnalyser();
            _calAnalyser.fftSize = 1024;
            _calAnalyser.smoothingTimeConstant = 0;
            src.connect(_calAnalyser);

            _calLevelHistory = [];
            calStartLabel.textContent = '\u23F9\uFE0F Stop Monitor';
            calAutoBtn.disabled = false;
            calHint.textContent = '';
            calTick();
        }

        function stopMonitor() {
            if (_calRaf) { cancelAnimationFrame(_calRaf); _calRaf = null; }
            if (_calStream) {
                _calStream.getTracks().forEach(t => t.stop());
                _calStream = null;
            }
            if (_calAudioCtx) {
                try { _calAudioCtx.close(); } catch {}
                _calAudioCtx = null;
            }
            _calAnalyser = null;
            _calAutoCalibrating = false;
            _calAutoSamples = null;
            calStartLabel.textContent = '\u25B6\uFE0F Start Monitor';
            calAutoBtn.disabled = true;
            calReadout.textContent = 'Monitor stopped.';
            calCtx.clearRect(0, 0, calCanvas.width, calCanvas.height);
        }

        calStartBtn.addEventListener('click', () => {
            if (_calStream) stopMonitor();
            else startMonitor();
        });

        calAutoBtn.addEventListener('click', async () => {
            if (!_calStream) {
                calHint.textContent = 'Start the monitor first.';
                return;
            }
            calHint.textContent = 'Sampling 3s of silence \u2014 stay quiet\u2026';
            calAutoBtn.disabled = true;
            _calAutoSamples = [];
            _calAutoCalibrating = true;
            await new Promise(r => setTimeout(r, 3000));
            _calAutoCalibrating = false;
            const samples = _calAutoSamples || [];
            _calAutoSamples = null;
            calAutoBtn.disabled = false;

            if (!samples.length) {
                calHint.textContent = 'No samples captured. Try again.';
                return;
            }
            // Take 95th percentile of silence samples * 1.3 as the new fixed floor.
            // This gives a threshold just above room noise but below speech.
            const p95 = percentile(samples, 95);
            const suggested = Math.max(0.0005, p95 * 1.3);
            calThreshold.value = suggested.toFixed(4);
            calHint.textContent =
                `Measured silence p95=${p95.toFixed(4)} \u2014 set floor to ${suggested.toFixed(4)}. Click Save to persist.`;
        });

        // Re-draw when user tweaks the fields manually
        [calThreshold, calMultiplier, calPercentile].forEach(inp => {
            inp.addEventListener('input', () => {
                if (_calAnalyser) {
                    _calCurrentAdaptive = computeAdaptive(_calLevelHistory);
                    drawMeter();
                    renderReadout();
                }
            });
        });

        async function loadCalibration() {
            const keys = Object.keys(calDefaults);
            const results = await Promise.all(keys.map(k => getSetting(k)));
            const get = (k) => {
                const r = results[keys.indexOf(k)];
                return r && r.value !== undefined && r.value !== null ? r.value : calDefaults[k];
            };
            calThreshold.value  = Number(get('RECORDER_SILENCE_THRESHOLD')).toFixed(4);
            calMultiplier.value = Number(get('RECORDER_NOISE_MULTIPLIER')).toFixed(2);
            calPercentile.value = Math.round(Number(get('RECORDER_BACKGROUND_PERCENTILE')));
            calDuration.value   = Number(get('RECORDER_SILENCE_DURATION')).toFixed(1);
        }

        calSaveBtn.addEventListener('click', async () => {
            calSaveBtn.disabled = true;
            calSaveHint.textContent = 'Saving\u2026';
            calSaveHint.className = 'ct-cal-save-hint';
            try {
                const updates = [
                    ['RECORDER_SILENCE_THRESHOLD', parseFloat(calThreshold.value)],
                    ['RECORDER_NOISE_MULTIPLIER', parseFloat(calMultiplier.value)],
                    ['RECORDER_BACKGROUND_PERCENTILE', parseFloat(calPercentile.value)],
                    ['RECORDER_SILENCE_DURATION', parseFloat(calDuration.value)],
                ];
                for (const [k, v] of updates) {
                    if (isNaN(v)) throw new Error(`Invalid value for ${k}`);
                    await putSetting(k, v, true);
                }
                calSaveHint.textContent = 'Saved \u2014 settings persist across restarts.';
                calSaveHint.className = 'ct-cal-save-hint ct-status-active';
                setTimeout(() => { calSaveHint.textContent = ''; }, 4000);
            } catch (e) {
                calSaveHint.textContent = `Error: ${e.message}`;
                calSaveHint.className = 'ct-cal-save-hint ct-status-error';
            } finally {
                calSaveBtn.disabled = false;
            }
        });

        calResetBtn.addEventListener('click', () => {
            calThreshold.value  = calDefaults.RECORDER_SILENCE_THRESHOLD.toFixed(4);
            calMultiplier.value = calDefaults.RECORDER_NOISE_MULTIPLIER.toFixed(2);
            calPercentile.value = String(calDefaults.RECORDER_BACKGROUND_PERCENTILE);
            calDuration.value   = calDefaults.RECORDER_SILENCE_DURATION.toFixed(1);
            calSaveHint.textContent = 'Defaults loaded \u2014 click Save to apply.';
            calSaveHint.className = 'ct-cal-save-hint';
            if (_calAnalyser) {
                _calCurrentAdaptive = computeAdaptive(_calLevelHistory);
                drawMeter();
                renderReadout();
            }
        });

        // Stop monitor on tab visibility change to release the mic
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && _calStream) stopMonitor();
        });

        // ═══ File drop / transcribe ═══
        function showFileStatus(msg, kind) {
            fileStatus.style.display = 'block';
            fileStatus.className = `ct-file-status ct-status-${kind || 'info'}`;
            fileStatus.innerHTML = msg;
        }

        function hideFileStatus() { fileStatus.style.display = 'none'; }

        async function transcribeFileUpload(file) {
            hideFileStatus();
            fileResult.style.display = 'none';
            showFileStatus(`Transcribing <strong>${esc(file.name)}</strong>\u2026`, 'info');

            const form = new FormData();
            form.append('file', file);

            try {
                const resp = await fetch(`${API}/transcribe`, {
                    method: 'POST',
                    headers: { 'X-CSRF-Token': CSRF() },
                    body: form
                });
                const data = await resp.json();
                if (data.error) {
                    showFileStatus(`Error: ${esc(data.error)}`, 'error');
                } else {
                    hideFileStatus();
                    fileResult.style.display = 'block';
                    fileMeta.textContent = `${data.file || 'audio'} \u2014 ${data.characters || 0} characters`;
                    fileText.value = data.text || '(no speech detected)';
                }
                refreshModelStatus();
            } catch (e) {
                showFileStatus(`Network error: ${esc(e.message)}`, 'error');
            }
        }

        dropzone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length) transcribeFileUpload(fileInput.files[0]);
        });
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('ct-dragging');
        });
        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('ct-dragging');
        });
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('ct-dragging');
            if (e.dataTransfer.files.length) transcribeFileUpload(e.dataTransfer.files[0]);
        });

        fileCopy.addEventListener('click', () => {
            navigator.clipboard.writeText(fileText.value).then(() => {
                fileCopy.textContent = 'Copied!';
                setTimeout(() => { fileCopy.textContent = 'Copy'; }, 1500);
            });
        });

        // ═══ Corrections ═══
        let _corrections = { enabled: true, pairs: [] };

        function renderCorrections() {
            corrEnabled.checked = _corrections.enabled !== false;
            corrStatus.textContent = _corrections.enabled === false
                ? 'Off \u2014 transcriptions pass through untouched'
                : `${_corrections.pairs.length} rule${_corrections.pairs.length === 1 ? '' : 's'} active`;
            corrStatus.className = _corrections.enabled === false
                ? 'ct-toggle-sub ct-status-inactive'
                : 'ct-toggle-sub ct-status-active';

            if (!_corrections.pairs.length) {
                corrList.innerHTML = `<div class="ct-corr-empty">No rules yet. Click <strong>+ Add Rule</strong> to create your first correction.</div>`;
                return;
            }

            corrList.innerHTML = _corrections.pairs.map((p, i) => `
                <div class="ct-corr-row" data-idx="${i}">
                    <input class="ct-corr-from" type="text"
                           placeholder="Misheard as..." value="${esc(p.from || '')}" />
                    <span class="ct-corr-arrow">\u2192</span>
                    <input class="ct-corr-to" type="text"
                           placeholder="Should be..." value="${esc(p.to || '')}" />
                    <label class="ct-corr-opt" title="Match whole words only">
                        <input type="checkbox" class="ct-corr-whole" ${p.whole_word !== false ? 'checked' : ''} />
                        <span>Whole</span>
                    </label>
                    <label class="ct-corr-opt" title="Case-insensitive match">
                        <input type="checkbox" class="ct-corr-ci" ${p.case_insensitive !== false ? 'checked' : ''} />
                        <span>Aa</span>
                    </label>
                    <button class="ct-corr-del" title="Remove rule" data-idx="${i}">\u00D7</button>
                </div>
            `).join('');

            corrList.querySelectorAll('.ct-corr-del').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.idx);
                    if (!isNaN(idx)) {
                        captureCorrInputs();
                        _corrections.pairs.splice(idx, 1);
                        renderCorrections();
                    }
                });
            });
        }

        function captureCorrInputs() {
            // Read current DOM state back into _corrections before rerender/save
            const rows = corrList.querySelectorAll('.ct-corr-row');
            const pairs = [];
            rows.forEach(row => {
                const from = row.querySelector('.ct-corr-from').value.trim();
                const to   = row.querySelector('.ct-corr-to').value;
                if (!from) return;
                pairs.push({
                    from,
                    to,
                    whole_word: row.querySelector('.ct-corr-whole').checked,
                    case_insensitive: row.querySelector('.ct-corr-ci').checked,
                });
            });
            _corrections.pairs = pairs;
        }

        async function loadCorrections() {
            try {
                const resp = await fetch(`${API}/corrections`, {
                    headers: { 'X-CSRF-Token': CSRF() }
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                _corrections = await resp.json();
                if (!_corrections || !Array.isArray(_corrections.pairs)) {
                    _corrections = { enabled: true, pairs: [] };
                }
            } catch (e) {
                corrStatus.textContent = `Error: ${e.message}`;
                corrStatus.className = 'ct-toggle-sub ct-status-error';
                _corrections = { enabled: true, pairs: [] };
            }
            renderCorrections();
        }

        corrEnabled.addEventListener('change', () => {
            _corrections.enabled = corrEnabled.checked;
            renderCorrections();
        });

        corrAdd.addEventListener('click', () => {
            captureCorrInputs();
            _corrections.pairs.push({ from: '', to: '', whole_word: true, case_insensitive: true });
            renderCorrections();
            // Focus the newly-added "from" input
            const rows = corrList.querySelectorAll('.ct-corr-row');
            const last = rows[rows.length - 1];
            if (last) last.querySelector('.ct-corr-from')?.focus();
        });

        corrSave.addEventListener('click', async () => {
            captureCorrInputs();
            corrSave.disabled = true;
            corrHint.textContent = 'Saving\u2026';
            corrHint.className = 'ct-corr-hint';
            try {
                const resp = await fetch(`${API}/corrections`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF() },
                    body: JSON.stringify(_corrections),
                });
                const data = await resp.json();
                if (data.error) {
                    corrHint.textContent = `Error: ${data.error}`;
                    corrHint.className = 'ct-corr-hint ct-status-error';
                } else {
                    corrHint.textContent = `Saved \u2014 ${data.saved} rule${data.saved === 1 ? '' : 's'} active`;
                    corrHint.className = 'ct-corr-hint ct-status-active';
                    renderCorrections();
                    setTimeout(() => { corrHint.textContent = ''; }, 3000);
                }
            } catch (e) {
                corrHint.textContent = `Network error: ${e.message}`;
                corrHint.className = 'ct-corr-hint ct-status-error';
            } finally {
                corrSave.disabled = false;
            }
        });

        // ═══ Initial state load ═══
        await Promise.all([
            refreshActivationState(),
            refreshWakeState(),
            refreshModelStatus(),
            loadCorrections(),
            loadCalibration(),
        ]);
    },

    async load() {
        // No per-plugin settings to load for this panel \u2014 activation lives
        // in core settings (STT_PROVIDER), fetched during render().
        return {};
    },

    async save(_settings) {
        // Nothing to batch-save \u2014 toggles persist immediately via PUT /api/settings/*.
        return;
    },
});

// Inject stylesheet (self-contained \u2014 no separate CSS file import needed)
(function injectStyles() {
    if (document.getElementById('ct-settings-styles')) return;
    const link = document.createElement('link');
    link.id = 'ct-settings-styles';
    link.rel = 'stylesheet';
    link.href = `/plugin-web/${PLUGIN}/cohere-transcribe.css`;
    document.head.appendChild(link);
})();
