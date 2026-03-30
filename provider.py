"""Cohere Transcribe STT provider — lazy-loaded, auto-unloading."""

import os
import time
import logging
import threading
from pathlib import Path
from typing import Optional

import soundfile as sf
import numpy as np

from core.stt.providers.base import BaseSTTProvider

logger = logging.getLogger(__name__)

MODEL_ID = "CohereLabs/cohere-transcribe-03-2026"


def _fix_ssl_cert():
    """Fix stale SSL_CERT_FILE from conda portable env."""
    cert = os.environ.get('SSL_CERT_FILE', '')
    if cert and not Path(cert).is_file():
        # Try the correct conda location
        for candidate in [
            Path(cert).parent.parent / 'Library' / 'ssl' / 'cacert.pem',
            Path(__file__).parents[2] / 'ssl' / 'cacert.pem',
        ]:
            if candidate.is_file():
                os.environ['SSL_CERT_FILE'] = str(candidate)
                return
        # Fall back to certifi if available
        try:
            import certifi
            os.environ['SSL_CERT_FILE'] = certifi.where()
        except ImportError:
            del os.environ['SSL_CERT_FILE']


def _safe_unlink(path, retries=3, delay=0.2):
    """Windows-safe file deletion with retries."""
    for attempt in range(retries):
        try:
            if os.path.exists(path):
                os.unlink(path)
            return
        except PermissionError:
            if attempt < retries - 1:
                time.sleep(delay)
        except Exception as e:
            logger.warning(f"Error deleting {path}: {e}")
            return


class CohereTranscribeProvider(BaseSTTProvider):
    """Local Cohere Transcribe STT — lazy load, auto-unload from VRAM."""

    def __init__(self):
        self._model = None
        self._processor = None
        self._lock = threading.Lock()
        self._last_used = 0.0
        self._unload_timer: Optional[threading.Timer] = None
        self._available = True

        # Read plugin settings via config
        try:
            import config
            self._model_id = getattr(config, 'COHERE_TRANSCRIBE_MODEL', MODEL_ID)
            self._device = getattr(config, 'COHERE_TRANSCRIBE_DEVICE', 'auto')
            self._dtype_str = getattr(config, 'COHERE_TRANSCRIBE_DTYPE', 'float16')
            self._unload_timeout = float(getattr(config, 'COHERE_TRANSCRIBE_UNLOAD_TIMEOUT', 60))
            self._punctuation = getattr(config, 'COHERE_TRANSCRIBE_PUNCTUATION', True)
            self._language = getattr(config, 'STT_LANGUAGE', 'en')
        except Exception:
            self._model_id = MODEL_ID
            self._device = 'auto'
            self._dtype_str = 'float16'
            self._unload_timeout = 60.0
            self._punctuation = True
            self._language = 'en'

        # Verify transformers is importable (don't load model yet)
        try:
            import transformers
            v = tuple(int(x) for x in transformers.__version__.split('.')[:2])
            if v < (4, 52):
                logger.warning(
                    f"transformers {transformers.__version__} may not support "
                    f"Cohere Transcribe — 5.4.0+ recommended"
                )
        except ImportError:
            logger.error("transformers not installed — Cohere Transcribe unavailable")
            self._available = False

    # ── lazy model loading ──────────────────────────────────────────

    def _resolve_device(self):
        import torch
        if self._device == 'auto':
            return 'cuda' if torch.cuda.is_available() else 'cpu'
        return self._device

    def _resolve_dtype(self):
        import torch
        mapping = {
            'float16': torch.float16,
            'bfloat16': torch.bfloat16,
            'float32': torch.float32,
        }
        return mapping.get(self._dtype_str, torch.float16)

    def _ensure_loaded(self):
        """Load model + processor on first use."""
        if self._model is not None:
            return

        logger.info(f"Loading Cohere Transcribe model: {self._model_id}")
        _fix_ssl_cert()
        start = time.time()

        from transformers import AutoProcessor, CohereAsrForConditionalGeneration

        device = self._resolve_device()
        dtype = self._resolve_dtype()

        self._processor = AutoProcessor.from_pretrained(self._model_id)

        # CPU requires float32; float16 is only useful on CUDA
        if device == 'cpu':
            import torch
            dtype = torch.float32
            self._model = CohereAsrForConditionalGeneration.from_pretrained(
                self._model_id, torch_dtype=dtype,
            )
            self._model.to('cpu')
        else:
            self._model = CohereAsrForConditionalGeneration.from_pretrained(
                self._model_id, torch_dtype=dtype, device_map=device,
            )

        elapsed = time.time() - start
        actual_device = next(self._model.parameters()).device
        logger.info(f"Cohere Transcribe loaded on {actual_device} in {elapsed:.1f}s")

    def _unload(self):
        """Free model from memory/VRAM."""
        with self._lock:
            if self._model is None:
                return
            # Check if used again since timer was set
            if self._unload_timeout > 0 and (time.time() - self._last_used) < self._unload_timeout:
                return
            logger.info("Unloading Cohere Transcribe model to free VRAM")
            del self._model
            del self._processor
            self._model = None
            self._processor = None

            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

    def _schedule_unload(self):
        """Schedule auto-unload after idle timeout."""
        if self._unload_timeout <= 0:
            return
        if self._unload_timer is not None:
            self._unload_timer.cancel()
        self._unload_timer = threading.Timer(self._unload_timeout, self._unload)
        self._unload_timer.daemon = True
        self._unload_timer.start()

    # ── transcription ───────────────────────────────────────────────

    def transcribe_file(self, audio_path: str) -> Optional[str]:
        with self._lock:
            try:
                # Read audio — try soundfile first, fall back to librosa (for m4a, mp3, etc.)
                try:
                    audio_data, sample_rate = sf.read(audio_path)
                    if len(audio_data.shape) > 1:
                        audio_data = audio_data.mean(axis=1)
                except Exception:
                    import librosa
                    audio_data, sample_rate = librosa.load(audio_path, sr=16000, mono=True)

                rms = np.sqrt(np.mean(audio_data ** 2))
                if rms < 0.001:
                    logger.warning(
                        f"[CohereSTT] Audio too quiet (RMS={rms:.6f}) — check mic"
                    )
                    return ""

                # Normalize peak
                max_val = np.max(np.abs(audio_data))
                if max_val > 0:
                    audio_data = audio_data / max_val

                # Resample to 16kHz if needed
                if sample_rate != 16000:
                    try:
                        import librosa
                        audio_data = librosa.resample(
                            audio_data, orig_sr=sample_rate, target_sr=16000
                        )
                    except ImportError:
                        from scipy.signal import resample
                        num_samples = int(len(audio_data) * 16000 / sample_rate)
                        audio_data = resample(audio_data, num_samples)
                    sample_rate = 16000

                # Lazy load
                self._ensure_loaded()
                self._last_used = time.time()

                # Read current language from config (may change at runtime)
                try:
                    import config
                    language = getattr(config, 'STT_LANGUAGE', self._language)
                except Exception:
                    language = self._language

                # Process
                inputs = self._processor(
                    audio_data,
                    sampling_rate=sample_rate,
                    return_tensors="pt",
                    language=language,
                    punctuation=self._punctuation,
                )
                audio_chunk_index = inputs.get("audio_chunk_index")
                inputs.to(self._model.device, dtype=self._model.dtype)

                outputs = self._model.generate(**inputs, max_new_tokens=512)

                # Decode — long-form needs audio_chunk_index
                if audio_chunk_index is not None:
                    text = self._processor.decode(
                        outputs,
                        skip_special_tokens=True,
                        audio_chunk_index=audio_chunk_index,
                        language=language,
                    )
                    if isinstance(text, list):
                        text = text[0]
                else:
                    text = self._processor.decode(
                        outputs, skip_special_tokens=True
                    )
                    if isinstance(text, list):
                        text = text[0]

                return text.strip() if text else ""

            except Exception as e:
                logger.error(f"Cohere Transcribe error: {e}", exc_info=True)
                return None

            finally:
                self._schedule_unload()

    # ── availability ────────────────────────────────────────────────

    def is_available(self) -> bool:
        return self._available
