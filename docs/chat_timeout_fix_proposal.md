# Patch Notes: Voice Chat Iteration Timeout Discards Valid LLM Responses

**For:** ddxfish (Sapphire maintainer)
**Target file:** `core/chat/chat.py`
**Target lines:** ~569–587 (post-`call_llm_with_metrics` timeout block)
**Affected path:** voice chat / non-streaming chat only. Text streaming path (`chat_streaming.py`) has zero references to `LLM_REQUEST_TIMEOUT` — already unaffected.
**Reported by:** Wolfreaper85
**Reproduced on:** `qwen3.5-9b-null-space-abliterated` @ LM Studio (local), 16k-token prompt, RTX 5070 Ti 16GB
**Proof-of-concept:** Running as a runtime monkey-patch inside `cohere-transcribe` plugin (`hooks/chat_timeout_patch.py`)

---

## 1. Bug

`core/chat/chat.py:569-587` enforces a **post-hoc** wall-clock budget on each tool iteration:

```python
iteration_time = time.time() - iteration_start_time
per_iteration_timeout = config.LLM_REQUEST_TIMEOUT / config.MAX_TOOL_ITERATIONS
if iteration_time > per_iteration_timeout:
    logger.warning(f"Iteration {i+1} exceeded {per_iteration_timeout:.0f}s timeout")
    timeout_text = f"I completed {tool_call_count} tool calls but processing got stuck (iteration timeout)."
    # ...
    return timeout_text   # ← discards the valid LLM response
```

This runs **after** `call_llm_with_metrics` has already returned a successful response. If the HTTP call had actually timed out, we'd be in the `except` branch above (L548). By the time we reach L569, we have a real response — a discard here is unnecessary and destroys valid output.

## 2. Impact on larger models

For large local models with long prompt-processing time, a single iteration legitimately takes 20–30s — most of that prompt eval, not generation. On default `LLM_REQUEST_TIMEOUT=240` / `MAX_TOOL_ITERATIONS=10`, per-iter budget is 24s. One user-reported case:

**LM Studio-side log:**
```
21:27:21  POST /v1/chat/completions received (16,193 prompt tokens)
21:27:38  prompt processing 85.4%
21:27:41  prompt processing 100%
21:27:44  Start to generate a tool call...
21:27:47  Model generated tool calls: [delegate_task(persona="sonic", task="Get the current...")]
21:27:47  HTTP 200 sent (completion 133 tokens)
```

**Sapphire-side log (same turn):**
```
21:27:21  Iteration 1/10
21:27:21  HTTP Request: POST http://127.0.0.1:1234/v1/chat/completions "HTTP/1.1 200 OK"
21:27:47  Iteration 1 exceeded 12s timeout      ← user had LLM_REQUEST_TIMEOUT=120
21:27:47  TTS: "I completed 0 tool calls but processing got stuck..."
```

Timing breakdown:
- **Prompt processing:** 21:27:21 → 21:27:41 ≈ **20s** for 16,193 tokens (~810 tok/s — normal for 9B on 5070 Ti at long context)
- **Generation:** 21:27:44 → 21:27:47 ≈ **3s** for 133 tokens
- **Total LLM call:** 26s, fully successful, valid `delegate_task` tool call returned

The response was discarded purely because 26s > 12s budget. Even with defaults (24s budget), the same call would have failed by ~2s.

## 3. Why the text path proves the check is unnecessary

Grep confirms `chat_streaming.py` has **zero** references to `LLM_REQUEST_TIMEOUT`, `per_iteration_timeout`, or `iteration_time`. The text path has shipped indefinitely without this check and has not produced runaway behavior in practice. The asymmetry is strong evidence the post-hoc check in `chat.py` was a mistake rather than a deliberate design choice.

## 4. Proposed fix (fully additive, backwards-compatible)

Add a new optional config `VOICE_LLM_TIMEOUT` — defaults to `LLM_REQUEST_TIMEOUT * 2` when unset, user-overridable in settings.json. Replace the per-iter divisor with the new value:

```diff
--- a/core/chat/chat.py
+++ b/core/chat/chat.py
@@ -566,7 +566,11 @@
                     self.session_manager.add_assistant_final(timeout_text, metadata=metadata)
                     return timeout_text

                 iteration_time = time.time() - iteration_start_time
-                per_iteration_timeout = config.LLM_REQUEST_TIMEOUT / config.MAX_TOOL_ITERATIONS
+                # VOICE_LLM_TIMEOUT lets local-model users give voice chat more
+                # headroom for prompt-eval on large models without raising
+                # HTTP timeouts for everything else. Defaults to 2x the base
+                # timeout when unset.
+                _voice_budget = getattr(config, 'VOICE_LLM_TIMEOUT', None)
+                _voice_budget = float(_voice_budget) if _voice_budget and float(_voice_budget) > 0 else (config.LLM_REQUEST_TIMEOUT * 2)
+                per_iteration_timeout = _voice_budget / max(1, config.MAX_TOOL_ITERATIONS)
                 if iteration_time > per_iteration_timeout:
                     logger.warning(f"Iteration {i+1} exceeded {per_iteration_timeout:.0f}s timeout")
```

And in `core/settings_defaults.json` (optional but helps discoverability):
```json
"llm": {
  "LLM_REQUEST_TIMEOUT": 240.0,
  "VOICE_LLM_TIMEOUT": 0,   // 0 = auto (2x LLM_REQUEST_TIMEOUT)
  ...
}
```

**Why this shape:**
- Zero behavior change for existing users with default settings (24s → 48s per-iter budget; they likely weren't hitting 24s anyway).
- Users on small/fast models: no impact.
- Users on large local models with long prompt eval: problem fixed out of the box.
- Power users can set `VOICE_LLM_TIMEOUT` explicitly for their hardware.
- HTTP connection timeouts (L173, 887, 905, 1040) continue to use `LLM_REQUEST_TIMEOUT` — unchanged.
- Text chat (`chat_streaming.py`) unaffected — doesn't read this config anyway.

## 5. Alternative — drop the check entirely

The post-hoc check is arguably not needed at all. If the HTTP layer timed out, the `except` at L548 handles it. `MAX_TOOL_ITERATIONS` still bounds runaway tool loops. The post-hoc check provides marginal value relative to the cost of throwing away valid responses. If you prefer the minimal diff:

```diff
-                iteration_time = time.time() - iteration_start_time
-                per_iteration_timeout = config.LLM_REQUEST_TIMEOUT / config.MAX_TOOL_ITERATIONS
-                if iteration_time > per_iteration_timeout:
-                    logger.warning(f"Iteration {i+1} exceeded {per_iteration_timeout:.0f}s timeout")
-                    timeout_text = f"I completed {tool_call_count} tool calls but processing got stuck (iteration timeout)."
-                    if force_prefill:
-                        timeout_text = force_prefill + timeout_text
-                    ...
-                    return timeout_text
+                iteration_time = time.time() - iteration_start_time
+                soft_budget = config.LLM_REQUEST_TIMEOUT / max(1, config.MAX_TOOL_ITERATIONS)
+                if iteration_time > soft_budget:
+                    logger.warning(
+                        f"Iteration {i+1} slow: {iteration_time:.1f}s > soft budget "
+                        f"{soft_budget:.0f}s. Continuing with returned response."
+                    )
```

Your call which shape you prefer — the `VOICE_LLM_TIMEOUT` approach keeps a safety valve, the soft-budget approach is the smallest diff.

## 6. Proof-of-concept

The reporter is running the `VOICE_LLM_TIMEOUT`-style fix as a runtime monkey-patch inside the `cohere-transcribe` plugin since 2026-04-14. The patch wraps `LLMChat.chat` to temporarily raise `config.LLM_REQUEST_TIMEOUT` for voice turns only, then restore it. File:

```
plugins/cohere-transcribe/hooks/chat_timeout_patch.py
```

Evidence post-patch (2026-04-14 soak):

9-iteration Lexi + Sonic delegated tool chain that previously would have aborted on iteration 1 now completes end-to-end:

```
Iter 1  (Lexi initial,  16,154 prompt tok): 22s   <- previously discarded at 24s default
Iter 2  (Lexi, cached)                    :  8s
Iter 3+ (Sonic sub-chain, weather/news)   : 8-17s each
Final   (Lexi synthesis, 17,913 prompt)   : 14s
```

All iterations pass the voice budget (48s default with patch). No observable change to text streaming path. No regression in short-prompt turns (<2k tokens) — they still complete well under the base budget. HTTP-level timeouts continue to fire normally on genuine stalls.

---

## TL;DR

- Post-hoc wall-clock check at `chat.py:569-587` discards successful LLM responses on local large models with long prompt-eval time.
- `chat_streaming.py` already has no such check, so text is fine. Asymmetry is the tell.
- Preferred fix: add `VOICE_LLM_TIMEOUT` (default `LLM_REQUEST_TIMEOUT * 2`), use it in the per-iter budget calc. ~4 lines changed, fully backwards-compatible.
- Runtime patch shipping in `cohere-transcribe` as proof-of-concept.
