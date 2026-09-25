# holon/backend/tests/test_llm_resilience.py
"""Resilient LLM layer: structured error classification + jittered-backoff retry.
Harvested from hermes-agent error_classifier.py + retry_utils.py (zero new deps).
Tests inject sleep/rand so they never actually wait."""
import requests
import pytest
from backend.engine import llm


# ---- classify_error: maps any exception to a recovery decision --------------

def test_classify_connection_error_is_retryable():
    c = llm.classify_error(requests.exceptions.ConnectionError("connection refused"))
    assert c.retryable is True
    assert c.kind == "connection"
    assert c.user_message  # non-empty, user-facing


def test_classify_timeout_is_retryable():
    c = llm.classify_error(requests.exceptions.Timeout("timed out"))
    assert c.retryable is True
    assert c.kind == "timeout"


def test_classify_rate_limit_is_retryable():
    c = llm.classify_error(RuntimeError("429 too many requests / rate limit exceeded"))
    assert c.retryable is True
    assert c.kind == "rate_limit"


def test_classify_subscription_is_not_retryable_and_suggests_local():
    c = llm.classify_error(RuntimeError("your subscription must be upgraded"))
    assert c.retryable is False
    assert c.should_fallback is True
    assert c.kind == "billing"
    assert "local" in c.user_message.lower()


def test_classify_unauthorized_is_not_retryable():
    c = llm.classify_error(RuntimeError("401 unauthorized: invalid api key"))
    assert c.retryable is False
    assert c.kind == "auth"
    assert "key" in c.user_message.lower()


def test_classify_context_overflow_flags_compress_not_retry():
    c = llm.classify_error(RuntimeError("input exceeds the maximum context length"))
    assert c.retryable is False
    assert c.should_compress is True
    assert c.kind == "context_overflow"


def test_classify_unknown_is_not_retryable_but_has_message():
    c = llm.classify_error(ValueError("something weird"))
    assert c.retryable is False
    assert c.kind == "unknown"
    assert "something weird" in c.user_message


# ---- with_retry: jittered backoff, only on retryable errors -----------------

def test_with_retry_succeeds_after_transient_failures():
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise requests.exceptions.ConnectionError("boom")
        return "ok"

    out = llm.with_retry(flaky, attempts=3, sleep=lambda s: None, rand=lambda: 0.5)
    assert out == "ok"
    assert calls["n"] == 3


def test_with_retry_does_not_retry_non_retryable():
    calls = {"n": 0}

    def auth_fail():
        calls["n"] += 1
        raise RuntimeError("401 unauthorized")

    with pytest.raises(RuntimeError):
        llm.with_retry(auth_fail, attempts=5, sleep=lambda s: None, rand=lambda: 0.5)
    assert calls["n"] == 1  # gave up immediately — no wasted retries


def test_with_retry_reraises_after_exhausting_attempts():
    def always_down():
        raise requests.exceptions.ConnectionError("down")

    with pytest.raises(requests.exceptions.ConnectionError):
        llm.with_retry(always_down, attempts=2, sleep=lambda s: None, rand=lambda: 0.5)


def test_backoff_delay_grows_and_is_jittered():
    # base * 2^(attempt-1), plus jitter in [0, base); deterministic with rand=0.5
    d0 = llm.backoff_delay(1, base=0.5, rand=lambda: 0.5)
    d1 = llm.backoff_delay(2, base=0.5, rand=lambda: 0.5)
    d2 = llm.backoff_delay(3, base=0.5, rand=lambda: 0.5)
    assert d0 < d1 < d2
    assert d0 == pytest.approx(0.5 * 1 + 0.5 * 0.5)  # 0.75


# ---- chat_stream raises a classified error; it never yields the error as a reply

def test_chat_stream_raises_classified_error_on_failure(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("your subscription must be upgraded")

    monkeypatch.setattr(llm.requests, "post", boom)
    with pytest.raises(llm.LLMError) as exc:
        "".join(llm.chat_stream([{"role": "user", "content": "hi"}], "cloud"))
    assert exc.value.kind == "billing" and "Local" in str(exc.value)   # steers the user to the Local tier
