// Cohere Transcribe — file transcription UI
(function () {
  const PLUGIN = 'cohere-transcribe';
  const API = `/api/plugin/${PLUGIN}`;

  function render(container) {
    container.innerHTML = `
      <div id="ct-root" style="
        max-width: 720px; margin: 0 auto; padding: 24px;
        font-family: var(--font-family, system-ui, sans-serif);
        color: var(--text-color, #e0e0e0);
      ">
        <h2 style="margin:0 0 4px; font-size:1.4em;">Cohere Transcribe</h2>
        <p style="margin:0 0 20px; opacity:0.6; font-size:0.9em;">
          Drop an audio file or paste a path to transcribe it locally.
        </p>

        <!-- Drop zone -->
        <div id="ct-dropzone" style="
          border: 2px dashed var(--border-color, #444);
          border-radius: 12px; padding: 48px 24px;
          text-align: center; cursor: pointer;
          transition: border-color 0.2s, background 0.2s;
          background: var(--surface-color, rgba(255,255,255,0.03));
        ">
          <div style="font-size: 2.5em; margin-bottom: 8px;">🎧</div>
          <div style="font-size: 1.05em; margin-bottom: 6px;">
            Drag &amp; drop audio file here
          </div>
          <div style="opacity: 0.5; font-size: 0.85em;">
            or click to browse &bull; WAV, MP3, FLAC, OGG, M4A, WebM
          </div>
          <input id="ct-file-input" type="file"
            accept=".wav,.mp3,.flac,.ogg,.m4a,.wma,.aac,.opus,.webm"
            style="display:none;" />
        </div>

        <!-- Or: paste a path -->
        <div style="
          display:flex; gap:8px; margin-top:16px; align-items:center;
        ">
          <input id="ct-path-input" type="text"
            placeholder="Or paste a file path: C:\\audio\\meeting.wav"
            style="
              flex:1; padding:10px 14px; border-radius:8px;
              border: 1px solid var(--border-color, #444);
              background: var(--input-bg, rgba(255,255,255,0.06));
              color: inherit; font-size: 0.95em;
              font-family: var(--mono-font, monospace);
            " />
          <select id="ct-lang" style="
            padding:10px 8px; border-radius:8px;
            border: 1px solid var(--border-color, #444);
            background: var(--input-bg, rgba(255,255,255,0.06));
            color: inherit; font-size: 0.9em;
          ">
            <option value="">Auto (setting)</option>
            <option value="en">English</option>
            <option value="fr">French</option>
            <option value="de">German</option>
            <option value="es">Spanish</option>
            <option value="pt">Portuguese</option>
            <option value="it">Italian</option>
            <option value="nl">Dutch</option>
            <option value="pl">Polish</option>
            <option value="el">Greek</option>
            <option value="zh">Chinese</option>
            <option value="ja">Japanese</option>
            <option value="ko">Korean</option>
            <option value="vi">Vietnamese</option>
            <option value="ar">Arabic</option>
          </select>
          <button id="ct-go-btn" style="
            padding:10px 20px; border-radius:8px; border:none;
            background: var(--accent-color, #6366f1); color:#fff;
            font-size:0.95em; cursor:pointer; white-space:nowrap;
          ">Transcribe</button>
        </div>

        <!-- Status -->
        <div id="ct-status" style="
          margin-top:16px; padding:12px 16px; border-radius:8px;
          background: var(--surface-color, rgba(255,255,255,0.03));
          display:none; font-size:0.9em;
        "></div>

        <!-- Result -->
        <div id="ct-result" style="display:none; margin-top:16px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <span id="ct-meta" style="opacity:0.5; font-size:0.85em;"></span>
            <button id="ct-copy-btn" style="
              padding:6px 14px; border-radius:6px; border:none;
              background: var(--surface-color, rgba(255,255,255,0.08));
              color: inherit; cursor:pointer; font-size:0.85em;
            ">Copy</button>
          </div>
          <textarea id="ct-text" readonly style="
            width:100%; min-height:200px; padding:14px;
            border-radius:8px; border: 1px solid var(--border-color, #444);
            background: var(--input-bg, rgba(255,255,255,0.04));
            color: inherit; font-size:0.95em; line-height:1.6;
            font-family: var(--font-family, system-ui, sans-serif);
            resize: vertical;
          "></textarea>
        </div>
      </div>
    `;

    // ── Wire up events ──

    const dropzone = container.querySelector('#ct-dropzone');
    const fileInput = container.querySelector('#ct-file-input');
    const pathInput = container.querySelector('#ct-path-input');
    const langSelect = container.querySelector('#ct-lang');
    const goBtn = container.querySelector('#ct-go-btn');
    const statusEl = container.querySelector('#ct-status');
    const resultEl = container.querySelector('#ct-result');
    const textArea = container.querySelector('#ct-text');
    const metaEl = container.querySelector('#ct-meta');
    const copyBtn = container.querySelector('#ct-copy-btn');

    // Click to browse
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) transcribeFile(fileInput.files[0]);
    });

    // Drag and drop
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--accent-color, #6366f1)';
      dropzone.style.background = 'rgba(99,102,241,0.08)';
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.style.borderColor = '';
      dropzone.style.background = '';
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = '';
      dropzone.style.background = '';
      if (e.dataTransfer.files.length) transcribeFile(e.dataTransfer.files[0]);
    });

    // Path button
    goBtn.addEventListener('click', () => {
      const p = pathInput.value.trim();
      if (p) transcribePath(p);
    });
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const p = pathInput.value.trim();
        if (p) transcribePath(p);
      }
    });

    // Copy
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(textArea.value).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });

    // ── Transcription functions ──

    function showStatus(msg, loading) {
      statusEl.style.display = 'block';
      statusEl.innerHTML = (loading ? '<span class="spinner" style="margin-right:8px;">⏳</span>' : '') + msg;
    }
    function hideStatus() { statusEl.style.display = 'none'; }

    function showResult(data) {
      resultEl.style.display = 'block';
      textArea.value = data.text || '(no speech detected)';
      metaEl.textContent = `${data.file || 'audio'} — ${data.characters || 0} characters`;
    }

    async function transcribeFile(file) {
      hideStatus();
      resultEl.style.display = 'none';
      showStatus(`Transcribing <strong>${file.name}</strong>...`, true);
      goBtn.disabled = true;

      const form = new FormData();
      form.append('file', file);
      const lang = langSelect.value;
      if (lang) form.append('language', lang);

      try {
        const resp = await fetch(`${API}/transcribe`, { method: 'POST', body: form });
        const data = await resp.json();
        if (data.error) {
          showStatus('Error: ' + data.error, false);
        } else {
          hideStatus();
          showResult(data);
        }
      } catch (e) {
        showStatus('Network error: ' + e.message, false);
      } finally {
        goBtn.disabled = false;
      }
    }

    async function transcribePath(filePath) {
      hideStatus();
      resultEl.style.display = 'none';
      const name = filePath.split(/[/\\]/).pop();
      showStatus(`Transcribing <strong>${name}</strong>...`, true);
      goBtn.disabled = true;

      const payload = { file_path: filePath };
      const lang = langSelect.value;
      if (lang) payload.language = lang;

      try {
        const resp = await fetch(`${API}/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (data.error) {
          showStatus('Error: ' + data.error, false);
        } else {
          hideStatus();
          showResult(data);
        }
      } catch (e) {
        showStatus('Network error: ' + e.message, false);
      } finally {
        goBtn.disabled = false;
      }
    }
  }

  // Auto-render if there's a mount point
  const mount = document.getElementById('plugin-mount') || document.currentScript?.parentElement;
  if (mount) render(mount);

  // Export for Sapphire's plugin UI loader
  window.cohereTranscribe = { render };
})();
