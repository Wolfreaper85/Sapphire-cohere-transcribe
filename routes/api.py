# routes/api.py
# API endpoint for file transcription

import os
import tempfile
import logging

logger = logging.getLogger(__name__)

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
