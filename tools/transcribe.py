# tools/transcribe.py
# Chat-accessible tool for file transcription via Cohere Transcribe

import os
import logging

logger = logging.getLogger(__name__)

ENABLED = True
EMOJI = '\U0001f3a7'

AVAILABLE_FUNCTIONS = ['transcribe_audio_file']

TOOLS = [
    {
        "type": "function",
        "is_local": True,
        "function": {
            "name": "transcribe_audio_file",
            "description": (
                "Transcribe an audio file to text using Cohere Transcribe. "
                "Use when the user asks to transcribe, convert speech to text, "
                "or get text from an audio/video file. Supports WAV, MP3, FLAC, "
                "OGG, M4A, and other common formats. Supports 14 languages."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to the audio file to transcribe"
                    },
                    "language": {
                        "type": "string",
                        "description": (
                            "Language code (default: uses STT_LANGUAGE setting). "
                            "Supported: en, fr, de, it, es, pt, el, nl, pl, "
                            "zh, ja, ko, vi, ar"
                        )
                    }
                },
                "required": ["file_path"]
            }
        }
    }
]


def _get_provider():
    """Get or create the Cohere Transcribe provider instance."""
    from core.stt.providers import stt_registry
    return stt_registry.create('cohere_transcribe')


def execute(tool_name: str, tool_input: dict, **kwargs):
    if tool_name != "transcribe_audio_file":
        return {"error": f"Unknown tool: {tool_name}"}

    file_path = tool_input.get("file_path", "").strip()
    if not file_path:
        return {"error": "No file_path provided"}

    # Normalize path separators
    file_path = os.path.normpath(file_path)

    if not os.path.isfile(file_path):
        return {"error": f"File not found: {file_path}"}

    # Check file size (limit to 500MB)
    size_mb = os.path.getsize(file_path) / (1024 * 1024)
    if size_mb > 500:
        return {"error": f"File too large ({size_mb:.0f}MB). Max is 500MB."}

    # Override language if specified
    language = tool_input.get("language")
    if language:
        try:
            import config
            original_lang = getattr(config, 'STT_LANGUAGE', 'en')
            config.STT_LANGUAGE = language
        except Exception:
            pass

    try:
        provider = _get_provider()
        if not provider.is_available():
            return {"error": "Cohere Transcribe is not available. Check that transformers>=5.4.0 is installed."}

        text = provider.transcribe_file(file_path)

        if text is None:
            return {"error": "Transcription failed — check logs for details"}

        if not text.strip():
            return {
                "text": "",
                "note": "No speech detected in the audio file"
            }

        return {
            "text": text.strip(),
            "file": os.path.basename(file_path),
            "characters": len(text.strip())
        }

    except Exception as e:
        logger.error(f"Transcribe tool error: {e}", exc_info=True)
        return {"error": str(e)}

    finally:
        # Restore original language if we overrode it
        if language:
            try:
                config.STT_LANGUAGE = original_lang
            except Exception:
                pass
