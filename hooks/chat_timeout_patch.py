# hooks/chat_timeout_patch.py
# Voice chat iteration-timeout patch (piggybacked on cohere-transcribe because
# this is the plugin that owns the voice input path; if you're using voice chat
# in Sapphire, you're almost certainly using this plugin).
#
# ── Bug being patched ──
# core/chat/chat.py:569-587 enforces a post-hoc wall-clock budget on each
# tool-calling iteration:
#
#     iteration_time = time.time() - iteration_start_time
#     per_iteration_timeout = config.LLM_REQUEST_TIMEOUT / config.MAX_TOOL_ITERATIONS
#     if iteration_time > per_iteration_timeout:
#         # ← DISCARDS the LLM response, returns canned "got stuck" string
#
# The problem: this runs AFTER call_llm_with_metrics has already returned a
# valid, well-formed response. If the provider's HTTP timeout had fired, we'd
# be in the `except` branch above. At this point the response is real — it
# shouldn't be thrown away.
#
# For large local models with long prompt-processing time (9B+ at 16k+ tokens),
# a single iteration can legitimately take 20-30s even on a 5070 Ti: ~20s of
# prompt eval + ~3s of generation. Default budget is 24s (240s / 10 iters),
# which barely clears it on a good day and fails reliably when the prompt is
# heavy or the GPU has any contention.
#
# Text chat path (core/chat/chat_streaming.py) does NOT read LLM_REQUEST_TIMEOUT
# anywhere — grep confirms zero references. So the check is voice-only, and the
# text path has shipped without it indefinitely. The asymmetry is the real tell
# that the post-hoc check is a mistake, not a deliberate design.
#
# ── What this patch does ──
# Wraps LLMChat.chat (the voice entry point) so that during the call,
# config.LLM_REQUEST_TIMEOUT is temporarily raised to VOICE_LLM_TIMEOUT
# (default: 2x LLM_REQUEST_TIMEOUT, user-overridable). After the call returns,
# the original value is restored. This widens the per-iter budget without
# touching HTTP timeouts for text chat or for any non-chat LLM use.
#
# ── What this patch does NOT do ──
# - Does NOT edit core files
# - Does NOT affect chat_streaming (text chat) — it doesn't read this config
# - Does NOT disable the post-hoc check — just gives it enough headroom that
#   legitimate slow responses stop getting eaten
# - Does NOT change provider HTTP timeouts permanently — only during voice turns,
#   which is harmless (an LLM call truly stuck for 480s on a local provider is
#   a real failure mode worth waiting for)
#
# ── Upstream fix proposal ──
# See chat_timeout_fix_proposal.md. Summary: add config.VOICE_LLM_TIMEOUT,
# default 2x LLM_REQUEST_TIMEOUT, read it in chat.py:570 for the per-iter budget.
# Fully additive, backwards-compatible.

import logging
import threading

import config

logger = logging.getLogger(__name__)

_patch_installed = False
_bump_lock = threading.Lock()
_bump_depth = 0
_saved_base_timeout = None


def _resolve_effective_timeout():
    """Figure out how big the voice-path budget should be.

    Rules:
      - If user set VOICE_LLM_TIMEOUT to a positive number, use it exactly.
      - If user set it to 0 or negative, treat as "disabled" — patch no-ops.
      - If unset, default to 2x LLM_REQUEST_TIMEOUT.
    Returns (base_timeout, effective_timeout). Caller bumps only if
    effective > base.
    """
    base = float(getattr(config, 'LLM_REQUEST_TIMEOUT', 240.0))
    override = getattr(config, 'VOICE_LLM_TIMEOUT', None)
    if override is None:
        return base, base * 2.0
    try:
        override = float(override)
    except (TypeError, ValueError):
        return base, base * 2.0
    if override <= 0:
        return base, base  # disabled
    return base, override


def _install_chat_timeout_patch():
    """Wrap LLMChat.chat so voice turns get a larger LLM_REQUEST_TIMEOUT.

    Idempotent — safe to call multiple times; only patches once.
    Fails gracefully if the target attribute has moved.
    """
    global _patch_installed
    if _patch_installed:
        return

    try:
        from core.chat.chat import LLMChat
    except Exception as e:
        logger.warning(f"[voice-timeout-patch] could not import LLMChat: {e}")
        return

    if not hasattr(LLMChat, 'chat') or not callable(getattr(LLMChat, 'chat', None)):
        logger.warning("[voice-timeout-patch] LLMChat.chat not found — patch skipped")
        return

    original_chat = LLMChat.chat

    # Guard against double-install if something re-imports us
    if getattr(original_chat, '_voice_timeout_patched', False):
        _patch_installed = True
        return

    def patched_chat(self, user_input: str):
        global _bump_depth, _saved_base_timeout

        base, effective = _resolve_effective_timeout()

        if effective <= base:
            return original_chat(self, user_input)

        bumped = False
        with _bump_lock:
            if _bump_depth == 0:
                _saved_base_timeout = config.LLM_REQUEST_TIMEOUT
                config.LLM_REQUEST_TIMEOUT = effective
                logger.debug(
                    f"[voice-timeout-patch] bump {_saved_base_timeout:.0f}s -> {effective:.0f}s"
                )
            _bump_depth += 1
            bumped = True

        try:
            return original_chat(self, user_input)
        finally:
            if bumped:
                with _bump_lock:
                    _bump_depth -= 1
                    if _bump_depth == 0 and _saved_base_timeout is not None:
                        config.LLM_REQUEST_TIMEOUT = _saved_base_timeout
                        _saved_base_timeout = None

    patched_chat._voice_timeout_patched = True
    LLMChat.chat = patched_chat
    _patch_installed = True

    base, effective = _resolve_effective_timeout()
    if effective > base:
        logger.info(
            f"[voice-timeout-patch] installed. base={base:.0f}s -> voice={effective:.0f}s "
            f"(per-iter budget: {base / max(1, getattr(config, 'MAX_TOOL_ITERATIONS', 10)):.0f}s "
            f"-> {effective / max(1, getattr(config, 'MAX_TOOL_ITERATIONS', 10)):.0f}s)"
        )
    else:
        logger.info(
            f"[voice-timeout-patch] installed but VOICE_LLM_TIMEOUT disabled "
            f"(override={effective:.0f}s, base={base:.0f}s)"
        )


# Install at module import time. Plugin loader imports this file when resolving
# the pre_chat hook declaration in plugin.json, which happens once at startup.
_install_chat_timeout_patch()


# No-op pre_chat hook. Its only real job is to cause this module to be imported
# via the plugin loader so the monkey-patch above runs. Kept minimal to avoid
# touching event.input or event.metadata and interfering with other plugins.
def pre_chat(event):
    return
