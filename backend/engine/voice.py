"""Voice → English text via faster-whisper (task='translate', any language in).
Runs on CPU, int8, no ffmpeg needed for WAV. Browsers may send webm/ogg; we try
to decode with faster-whisper's reader which handles common containers."""
import time
from functools import lru_cache
from .. import config

LANG_NAMES = {"en": "English", "si": "Sinhala", "ta": "Tamil", "zh": "Chinese",
              "hi": "Hindi", "es": "Spanish", "fr": "French", "de": "German",
              "ja": "Japanese", "ko": "Korean", "ar": "Arabic", "ru": "Russian",
              "pt": "Portuguese", "it": "Italian", "nl": "Dutch"}


@lru_cache(maxsize=1)
def _get_model():
    try:
        from faster_whisper import WhisperModel
        return WhisperModel("base", device="cpu", compute_type="int8"), None
    except Exception as e:
        return None, str(e)


def translate_bytes(audio_bytes, suffix=".wav"):
    """Return (english_text, detected_language, error)."""
    if not audio_bytes or len(audio_bytes) < 2000:
        return "", None, None
    model, err = _get_model()
    if model is None:
        return "", None, err
    tmp = config.DATA_DIR / f"mic_{int(time.time()*1000)}{suffix}"
    tmp.write_bytes(audio_bytes)
    try:
        segments, info = model.transcribe(str(tmp), task="translate")
        text = " ".join(s.text for s in segments).strip()
        return text, getattr(info, "language", None), None
    except Exception as e:
        return "", None, str(e)
    finally:
        try:
            tmp.unlink()
        except Exception:
            pass
