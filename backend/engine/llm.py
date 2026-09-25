"""Ollama access: streaming chat (local daemon or hosted cloud) + a
non-streaming, JSON-constrained typed-entity extraction call.

Critical: /api/chat IGNORES a top-level "system" field — the system prompt MUST
be a system-role message or the model never sees memories/docs/graph.
"""
import json
import os
import re
import random
import time
from dataclasses import dataclass
import requests
from .. import config


# ---- resilience: structured error classification + jittered backoff --------
# Harvested from hermes-agent error_classifier.py + retry_utils.py (zero deps).

@dataclass
class ClassifiedError:
    """A recovery decision derived from an LLM/transport exception."""
    kind: str            # connection | timeout | rate_limit | billing | auth | context_overflow | unknown
    retryable: bool      # safe to retry the same request after a backoff?
    user_message: str    # friendly, actionable text to surface in the chat
    should_fallback: bool = False   # steer the user to the Local tier
    should_compress: bool = False   # the prompt was too long — compress and retry


class LLMError(RuntimeError):
    """A model call failed after retries. ``kind`` is the classifier's label
    (timeout, auth, billing, …); ``partial`` says whether tokens had already
    streamed, so the caller knows the failure interrupted a reply."""

    def __init__(self, message, kind="error", partial=False):
        super().__init__(message)
        self.kind, self.partial = kind, partial


def classify_error(exc):
    """Map any exception into a ClassifiedError. String-based, like hermes, so it
    survives the many shapes an Ollama/requests/HTTP failure can take."""
    msg = str(exc).lower()

    if isinstance(exc, requests.exceptions.Timeout) or "timed out" in msg or "timeout" in msg:
        return ClassifiedError("timeout", True,
                               "⚠️ The model took too long — retrying…")
    if "subscription" in msg or "upgrade" in msg or "402" in msg or "payment" in msg:
        return ClassifiedError("billing", False,
                               "☁️ Cloud model needs a paid Ollama plan. Switch to Local in the top bar.",
                               should_fallback=True)
    if "unauthorized" in msg or "401" in msg or "invalid api key" in msg or "forbidden" in msg or "403" in msg:
        return ClassifiedError("auth", False,
                               "☁️ Cloud key missing/invalid. Add it to holon/.ollama_key, or switch to Local.")
    if "rate" in msg or "429" in msg or "too many requests" in msg:
        return ClassifiedError("rate_limit", True,
                               "⚠️ Rate-limited by the model — retrying…")
    if "context" in msg or "too long" in msg or "maximum context" in msg or "context length" in msg:
        return ClassifiedError("context_overflow", False,
                               "⚠️ This conversation got too long for the model.",
                               should_compress=True)
    if isinstance(exc, requests.exceptions.ConnectionError) or "connection" in msg or "refused" in msg:
        return ClassifiedError("connection", True,
                               "⚠️ Couldn't reach the model — retrying…")
    return ClassifiedError("unknown", False, f"⚠️ Error talking to Ollama: {exc}")


def backoff_delay(attempt, base=0.5, max_delay=8.0, rand=random.random):
    """Exponential backoff with uniform jitter: base*2^(attempt-1) + base*jitter.
    `attempt` is 1-based. `rand` is injectable so tests are deterministic."""
    exp = min(base * (2 ** (attempt - 1)), max_delay)
    return exp + base * rand()


def with_retry(fn, attempts=3, base=0.5, sleep=time.sleep, rand=random.random):
    """Call fn(); on a *retryable* classified error, back off and retry up to
    `attempts` times. Non-retryable errors raise immediately (no wasted retries).
    sleep/rand are injectable so tests never actually wait."""
    last = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 — classify decides what to do
            last = e
            c = classify_error(e)
            if not c.retryable or attempt == attempts:
                raise
            sleep(backoff_delay(attempt, base=base, rand=rand))
    raise last  # unreachable, but keeps the contract explicit


def endpoint_for(tier):
    c = config.tier_config(tier)
    if c["local"]:
        return c["llm_url"], {}, c["model"]
    if c.get("api") == "openai":
        key = os.getenv("MODEL_STUDIO_API_KEY", "").strip()
    else:
        key = (os.getenv("HOLON_CUSTOM_KEY", "").strip()
               if c.get("label", "").startswith("Custom") else config.load_api_key())
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    return c["llm_url"], headers, c["model"]


def api_kind(tier):
    """'ollama' (Ollama /api/chat, the default) or 'openai' (an OpenAI-compatible
    /chat/completions server such as Model Studio)."""
    return config.tier_config(tier).get("api", "ollama")


def cloud_configured(tier="cloud"):
    """True when the tier can actually be called: local tiers always, cloud
    tiers only with a key."""
    c = config.tier_config(tier)
    if c["local"]:
        return True
    _, headers, _ = endpoint_for(tier)
    return bool(headers.get("Authorization"))


def _openai_stream(url, headers, model, msgs):
    """Token generator over an OpenAI-compatible streaming chat completion."""
    payload = {"model": model, "messages": msgs, "stream": True}
    with requests.post(f"{url}/chat/completions", json=payload,
                       headers={**headers, "Content-Type": "application/json"},
                       stream=True, timeout=180) as r:
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        for line in r.iter_lines():
            if not line:
                continue
            line = line.decode() if isinstance(line, bytes) else line
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                return
            chunk = json.loads(data)
            if chunk.get("error"):
                raise RuntimeError(str(chunk["error"]))
            for choice in chunk.get("choices") or []:
                text = (choice.get("delta") or {}).get("content")
                if text:
                    yield text


def ollama_running():
    try:
        return requests.get(f"{config.OLLAMA_URL}/api/tags", timeout=2).status_code == 200
    except Exception:
        return False


def chat_stream(messages, tier, system="", attempts=3, sleep=time.sleep):
    """Yield reply tokens (str) one chunk at a time. Retryable failures that occur
    *before the first token* are retried with jittered backoff; once tokens have
    streamed, any failure is surfaced as a classified, actionable message (we never
    re-stream and duplicate output)."""
    url, headers, model = endpoint_for(tier)
    msgs = ([{"role": "system", "content": system}] if system else []) + messages
    payload = {"model": model, "messages": msgs, "stream": True}
    openai_api = api_kind(tier) == "openai"
    for attempt in range(1, attempts + 1):
        produced = False
        try:
            if openai_api:
                for text in _openai_stream(url, headers, model, msgs):
                    produced = True
                    yield text
                return
            with requests.post(f"{url}/api/chat", json=payload, headers=headers,
                               stream=True, timeout=180) as r:
                for line in r.iter_lines():
                    if not line:
                        continue
                    chunk = json.loads(line)
                    if chunk.get("error"):
                        raise RuntimeError(chunk["error"])
                    if "message" in chunk:
                        produced = True
                        yield chunk["message"].get("content", "")
            return
        except Exception as e:  # noqa: BLE001 — classify decides retry vs. surface
            c = classify_error(e)
            if c.retryable and not produced and attempt < attempts:
                sleep(backoff_delay(attempt))
                continue
            # A failure is an error, not an answer: the route turns this into
            # an `error` event, and nothing is stored as the assistant's reply.
            raise LLMError(c.user_message, kind=c.kind, partial=produced) from e


def chat_once(messages, tier, system="", fmt=None):
    """Non-streaming single reply (used by extraction). fmt='json' asks Ollama for
    JSON. Wrapped in with_retry so transient transport blips don't lose a turn."""
    url, headers, model = endpoint_for(tier)
    msgs = ([{"role": "system", "content": system}] if system else []) + messages
    if api_kind(tier) == "openai":
        payload = {"model": model, "messages": msgs, "stream": False}
        if fmt == "json":
            payload["response_format"] = {"type": "json_object"}

        def _call_openai():
            r = requests.post(f"{url}/chat/completions", json=payload,
                              headers={**headers, "Content-Type": "application/json"}, timeout=120)
            r.raise_for_status()
            choices = r.json().get("choices") or []
            return ((choices[0].get("message") or {}).get("content") or "") if choices else ""

        return with_retry(_call_openai)

    payload = {"model": model, "messages": msgs, "stream": False}
    if fmt:
        payload["format"] = fmt

    def _call():
        r = requests.post(f"{url}/api/chat", json=payload, headers=headers, timeout=120)
        r.raise_for_status()
        return r.json().get("message", {}).get("content", "")

    return with_retry(_call)


def _find_payload(obj):
    """Find the dict holding entities/relations, even when a model wraps it in an
    outer object (e.g. {"result": {"entities": [...]}}) or returns a list."""
    if isinstance(obj, dict):
        if "entities" in obj or "relations" in obj:
            return obj
        for v in obj.values():
            found = _find_payload(v)
            if found:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_payload(v)
            if found:
                return found
    return None


def _clean_llm_json(raw):
    """Best-effort recovery of a JSON object from a noisy LLM reply."""
    if not raw:
        return {}
    text = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL | re.IGNORECASE).strip()
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    candidates = []
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        candidates.append(m.group(0))
    candidates.append(text)
    for c in candidates:
        for attempt in (c, re.sub(r",\s*([}\]])", r"\1", c)):  # strip trailing commas
            try:
                return json.loads(attempt)
            except Exception:
                continue
    return {}


def parse_extraction(raw):
    """Tolerantly pull the entities/relations payload out of an LLM reply, even if
    it is wrapped in an outer object or trailed by commentary."""
    loaded = _clean_llm_json(raw)
    data = _find_payload(loaded) or {}
    ents = data.get("entities") or []
    rels = data.get("relations") or []
    ents = [{"name": e.get("name", "").strip(), "type": e.get("type", "Topic")}
            for e in ents if isinstance(e, dict) and e.get("name")]
    rels = [{"subject": r.get("subject", "").strip(),
             "predicate": r.get("predicate", "related_to"),
             "object": r.get("object", "").strip(),
             "valid_time": r.get("valid_time")}
            for r in rels if isinstance(r, dict) and r.get("subject") and r.get("object")]
    return {"entities": ents, "relations": rels}
