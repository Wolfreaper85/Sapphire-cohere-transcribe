"""
post_stt hook — Transcription correction rules.

Applies user-defined find/replace pairs to every STT transcription before
it reaches the LLM. Useful for fixing common mistranscriptions of
persona names ("Lexie" -> "Lexi"), domain terms, or proper nouns that
the ASR model routinely gets wrong.

IMPORTANT: This hook MUST be `def`, not `async def` — Sapphire's
hook_runner.fire() is synchronous and silently drops async coroutines.

Corrections are stored in a plugin-local JSON file and loaded lazily.
Changes made via the settings UI are picked up on the next transcription
(the file is re-read on each fire() call — cheap because it's tiny).
"""

import json
import logging
import re
from pathlib import Path
from threading import Lock

logger = logging.getLogger(__name__)

# ── Paths ──
_PLUGIN_DIR = Path(__file__).parent.parent
_CORRECTIONS_FILE = _PLUGIN_DIR / "corrections.json"

# ── Cache ──
_lock = Lock()
_cache = {
    "mtime": 0.0,
    "pairs": [],        # list of {"from": str, "to": str, "whole_word": bool}
    "compiled": [],     # list of (compiled_regex, replacement)
    "enabled": True,
}


def _load_corrections():
    """Load corrections from disk if the file has changed.

    Returns the list of compiled (regex, replacement) tuples.
    Cheap to call on every hook fire — only re-parses when mtime changes.
    """
    with _lock:
        try:
            if not _CORRECTIONS_FILE.exists():
                _cache["pairs"] = []
                _cache["compiled"] = []
                return _cache["compiled"]

            mtime = _CORRECTIONS_FILE.stat().st_mtime
            if mtime == _cache["mtime"] and _cache["compiled"]:
                return _cache["compiled"]

            with _CORRECTIONS_FILE.open("r", encoding="utf-8") as f:
                data = json.load(f)

            pairs = data.get("pairs", []) if isinstance(data, dict) else []
            enabled = data.get("enabled", True) if isinstance(data, dict) else True

            compiled = []
            for pair in pairs:
                if not isinstance(pair, dict):
                    continue
                src = pair.get("from", "").strip()
                dst = pair.get("to", "")
                if not src:
                    continue
                whole_word = bool(pair.get("whole_word", True))
                case_insensitive = bool(pair.get("case_insensitive", True))

                escaped = re.escape(src)
                if whole_word:
                    # Use word boundaries so "lex" doesn't match "alexander"
                    pattern = rf"\b{escaped}\b"
                else:
                    pattern = escaped
                flags = re.IGNORECASE if case_insensitive else 0
                try:
                    compiled.append((re.compile(pattern, flags), dst))
                except re.error as e:
                    logger.warning(f"[stt_corrections] Bad pattern '{src}': {e}")

            _cache["mtime"] = mtime
            _cache["pairs"] = pairs
            _cache["compiled"] = compiled
            _cache["enabled"] = enabled
            return compiled
        except Exception as e:
            logger.error(f"[stt_corrections] Failed to load {_CORRECTIONS_FILE}: {e}")
            return []


def post_stt(event):
    """Apply correction rules to the transcription in event.input.

    Runs after STT finishes, before the text is sent to the LLM.
    No-op if no corrections are configured or the feature is disabled.
    """
    text = event.input or ""
    if not text:
        return

    try:
        compiled = _load_corrections()
        if not _cache.get("enabled", True) or not compiled:
            return

        corrected = text
        hits = 0
        for pattern, replacement in compiled:
            new_text, count = pattern.subn(replacement, corrected)
            if count:
                hits += count
                corrected = new_text

        if hits and corrected != text:
            logger.info(f"[stt_corrections] Applied {hits} correction(s)")
            event.input = corrected
    except Exception as e:
        # Never let a broken correction file take down the pipeline
        logger.error(f"[stt_corrections] Hook error: {e}", exc_info=True)
