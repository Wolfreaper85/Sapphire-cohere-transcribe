# routes/api.py
# API endpoints for file transcription and correction rules

import json
import os
import tempfile
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_PLUGIN_DIR = Path(__file__).parent.parent
_CORRECTIONS_FILE = _PLUGIN_DIR / "corrections.json"

ALLOWED_EXTENSIONS = {'.wav', '.mp3', '.flac', '.ogg', '.m4a', '.wma', '.aac', '.opus', '.webm'}
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500MB


def _get_provider():
    from core.stt.providers import stt_registry
    return stt_registry.create('cohere_transcribe')


# POST /api/plugin/cohere-transcribe/transcribe
async def transcribe(**kwargs):
    """Transcribe an uploaded audio file or a file path on disk."""
    request = kwargs.get('request')

    content_type = request.headers.get("content-type", "") if request else ""

    # ── Multipart upload (drag-and-drop / file upload from UI) ──
    if "multipart" in content_type:
        form = await request.form()
        file = form.get('file')
        if not file:
            return {"error": "No file uploaded"}

        ext = os.path.splitext(file.filename or '')[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            return {"error": f"Unsupported format '{ext}'. Supported: {', '.join(sorted(ALLOWED_EXTENSIONS))}"}

        content = await file.read()
        if len(content) > MAX_FILE_SIZE:
            return {"error": f"File too large ({len(content) // 1024 // 1024}MB). Max is 500MB."}

        language = form.get('language')

        # Write to temp file for the provider
        fd, temp_path = tempfile.mkstemp(suffix=ext, prefix="cohere_upload_")
        os.close(fd)
        try:
            with open(temp_path, 'wb') as f:
                f.write(content)
            return _do_transcribe(temp_path, language, filename=file.filename)
        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

    # ── JSON body with file_path (local file on disk) ──
    body = kwargs.get('body', {})
    file_path = body.get('file_path', '').strip()
    if not file_path:
        return {"error": "Provide a file upload (multipart) or JSON body with 'file_path'"}

    file_path = os.path.normpath(file_path)
    if not os.path.isfile(file_path):
        return {"error": f"File not found: {file_path}"}

    language = body.get('language')
    return _do_transcribe(file_path, language)


def _do_transcribe(file_path: str, language: str = None, filename: str = None):
    """Run transcription and return result dict."""
    if language:
        try:
            import config
            original = getattr(config, 'STT_LANGUAGE', 'en')
            config.STT_LANGUAGE = language
        except Exception:
            language = None

    try:
        provider = _get_provider()
        if not provider.is_available():
            return {"error": "Cohere Transcribe unavailable. Is transformers>=5.4.0 installed?"}

        text = provider.transcribe_file(file_path)

        if text is None:
            return {"error": "Transcription failed — check server logs"}

        return {
            "text": text.strip(),
            "file": filename or os.path.basename(file_path),
            "characters": len(text.strip())
        }

    except Exception as e:
        logger.error(f"Transcribe API error: {e}", exc_info=True)
        return {"error": str(e)}

    finally:
        if language:
            try:
                config.STT_LANGUAGE = original
            except Exception:
                pass


# GET /api/plugin/cohere-transcribe/status
def status(**kwargs):
    """Check if the provider is loaded and available."""
    try:
        provider = _get_provider()
        loaded = provider._model is not None
        return {
            "available": provider.is_available(),
            "loaded": loaded,
            "model": provider._model_id,
            "device": provider._device,
        }
    except Exception as e:
        return {"available": False, "error": str(e)}


# ── Transcription corrections (post_stt hook backing store) ──

def _default_corrections():
    return {"enabled": True, "pairs": []}


def _read_corrections():
    try:
        if not _CORRECTIONS_FILE.exists():
            return _default_corrections()
        with _CORRECTIONS_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return _default_corrections()
        pairs = data.get("pairs", [])
        if not isinstance(pairs, list):
            pairs = []
        return {
            "enabled": bool(data.get("enabled", True)),
            "pairs": pairs,
        }
    except Exception as e:
        logger.error(f"Failed reading corrections: {e}")
        return _default_corrections()


def _sanitize_pair(raw):
    """Clamp a user-supplied correction pair into a safe shape."""
    if not isinstance(raw, dict):
        return None
    src = str(raw.get("from", "")).strip()
    dst = str(raw.get("to", ""))
    if not src:
        return None
    return {
        "from": src[:200],
        "to": dst[:500],
        "whole_word": bool(raw.get("whole_word", True)),
        "case_insensitive": bool(raw.get("case_insensitive", True)),
    }


# GET /api/plugin/cohere-transcribe/corrections
def get_corrections(**kwargs):
    """Return current correction rules and on/off state."""
    return _read_corrections()


# PUT /api/plugin/cohere-transcribe/corrections
async def save_corrections(**kwargs):
    """Replace the correction rules list.

    Body: {"enabled": bool, "pairs": [{"from": str, "to": str,
                                       "whole_word": bool,
                                       "case_insensitive": bool}, ...]}
    """
    body = kwargs.get("body") or {}
    if not isinstance(body, dict):
        return {"error": "Body must be a JSON object"}

    raw_pairs = body.get("pairs", [])
    if not isinstance(raw_pairs, list):
        return {"error": "'pairs' must be a list"}

    # Cap at 200 pairs so a buggy UI can't blow up the regex cache
    cleaned = []
    for raw in raw_pairs[:200]:
        pair = _sanitize_pair(raw)
        if pair:
            cleaned.append(pair)

    data = {
        "enabled": bool(body.get("enabled", True)),
        "pairs": cleaned,
    }

    try:
        _CORRECTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with _CORRECTIONS_FILE.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return {"status": "ok", "saved": len(cleaned), "enabled": data["enabled"]}
    except Exception as e:
        logger.error(f"Failed saving corrections: {e}")
        return {"error": str(e)}
