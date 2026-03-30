# Sapphire Cohere Transcribe Plugin

Local speech-to-text plugin for [Sapphire](https://github.com/Wolfreaper85) using Cohere's 2B-parameter Transcribe model. 14 languages, long-form audio, WAV/MP3/M4A/FLAC support. Transcribe via chat, API, or drag-and-drop UI. Lazy-loads on first use, auto-unloads when idle. Fully local, no cloud API. Apache 2.0.

## Features

- **14 Languages** — English, French, German, Spanish, Portuguese, Italian, Dutch, Polish, Greek, Chinese, Japanese, Korean, Vietnamese, Arabic
- **Long-form audio** — automatic chunking for files over 35 seconds
- **Multiple formats** — WAV, MP3, M4A, FLAC, OGG, AAC, OPUS, WebM
- **Three ways to use** — chat command, REST API, or drag-and-drop web UI
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

6. Enable the plugin in Sapphire settings and select "Cohere Transcribe (Local)" as your STT provider.

## Usage

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
