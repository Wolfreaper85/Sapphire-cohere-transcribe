# Sapphire Cohere Transcribe Plugin

Local speech-to-text plugin for [Sapphire](https://github.com/Wolfreaper85) using Cohere's 2B-parameter Transcribe model. 14 languages, long-form audio, WAV/MP3/M4A/FLAC support. Transcribe via chat, API, or drag-and-drop UI. Lazy-loads on first use, auto-unloads when idle. Fully local, no cloud API. Apache 2.0.

## Features

- **14 Languages** — English, French, German, Spanish, Portuguese, Italian, Dutch, Polish, Greek, Chinese, Japanese, Korean, Vietnamese, Arabic
- **Long-form audio** — automatic chunking for files over 35 seconds
- **Multiple formats** — WAV, MP3, M4A, FLAC, OGG, AAC, OPUS, WebM
- **Drop-in STT provider** — one-click activation as Sapphire's system-wide speech-to-text engine
- **Wake-word integration** — say the wake word and have your speech routed to the active persona
- **One-tab control panel** — activation toggle, mic test, model status, and file transcription in Settings
- **Lazy loading** — model only loads into memory on first transcription
- **Auto-unload** — frees memory after 60s idle (configurable)
- **Fully local** — runs entirely on your machine after initial model download

## Requirements

- [Sapphire](https://github.com/Wolfreaper85) assistant platform
- Python 3.10+
- `transformers>=5.4.0`, `torch`, `soundfile`, `librosa`, `sentencepiece`, `protobuf`, `accelerate`
- `ffmpeg` installed and on PATH (required for MP3/M4A decoding)
- HuggingFace account with access to the gated model (one-time setup)

## Installation

1. Clone into your Sapphire plugins directory:
   ```
   cd /path/to/sapphire-dev/plugins
   git clone https://github.com/Wolfreaper85/Sapphire-cohere-transcribe.git cohere-transcribe
   ```

2. Install dependencies:
   ```
   pip install "transformers>=5.4.0" librosa sentencepiece protobuf accelerate
   ```

3. Install ffmpeg (if not already installed):
   ```
   winget install ffmpeg
   ```

4. Accept the model license on HuggingFace:
   - Visit https://huggingface.co/CohereLabs/cohere-transcribe-03-2026
   - Click "Agree and access repository"

5. Log in to HuggingFace:
   ```
   huggingface-cli login
   ```

6. Enable the plugin in **Plugin Manager**, then open **Settings → Cohere Transcribe** and flip the **Activate as STT Provider** toggle. No restart needed — the switch is live.

## Usage

### Wake-word voice input (hands-free)
With the plugin active and wake word enabled, say the wake word (default: "Hey Sapphire"), wait for the activation tone, then speak your message. Cohere transcribes it and the text is routed to the active persona as if you'd typed it.

### Settings panel
**Settings → Cohere Transcribe** gives you the full plugin control surface:
- **STT Provider toggle** — activate/deactivate as the system-wide speech engine (hot-swap, no restart)
- **Wake Word toggle** — turn voice activation on/off directly from this panel
- **Microphone Test** — record 5 seconds in your browser and preview the transcription
- **Model Status** — see whether the model is currently loaded in VRAM, model ID, device, and readiness
- **Transcription Corrections** — define find/replace rules that fix common mistranscriptions (e.g. "Lexie" → "Lexi") before the text reaches the LLM. Runs as a `post_stt` hook.
- **File Transcription** — drag-and-drop any audio file for one-off transcription (useful for voice-clone reference audio)

### Chat
Ask Sapphire to transcribe a file:
> "Transcribe E:\Audio\meeting.m4a"

### API
Upload a file:
```bash
curl -X POST http://localhost:8073/api/plugin/cohere-transcribe/transcribe \
  -F "file=@recording.wav" \
  -F "language=en"
```

Or point to a local path:
```bash
curl -X POST http://localhost:8073/api/plugin/cohere-transcribe/transcribe \
  -H "Content-Type: application/json" \
  -d '{"file_path": "E:\\Audio\\meeting.m4a", "language": "en"}'
```

### Web UI
Open the Cohere Transcribe page in Sapphire's plugin UI. Drag and drop an audio file or paste a file path, select a language, and click Transcribe.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Model ID | `CohereLabs/cohere-transcribe-03-2026` | HuggingFace model ID |
| Device | `auto` | `auto`, `cuda`, or `cpu` |
| Precision | `float16` | `float16`, `bfloat16`, or `float32` (CPU forces float32) |
| Auto-unload | `60` | Seconds of idle before freeing memory (0 = never) |
| Punctuation | `true` | Include punctuation in output |

## Model

This plugin uses [Cohere Transcribe](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026), a 2B-parameter Conformer encoder-decoder ASR model. The model is gated on HuggingFace — you must accept the license terms before first use. Once downloaded (~4GB), it is cached locally and runs fully offline.

## License

Apache License 2.0
