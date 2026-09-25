# holon/backend/tests/test_context_compress.py
"""Conversation compression: instead of silently DROPPING the oldest turns when a
conversation outgrows the token budget (trim_to_budget), summarise them into a
framed background block so the twin never forgets what was said.
Harvested from hermes-agent context_compressor.py (zero new deps)."""
from backend.engine import context
from backend.engine.context import compress_to_budget, SUMMARY_PREFIX


def _msgs(n):
    return [{"role": "user" if i % 2 == 0 else "assistant",
             "content": f"message number {i} " * 20} for i in range(n)]


def test_small_history_is_untouched():
    m = _msgs(4)
    assert compress_to_budget(m, budget_tokens=100000) == m


def test_over_budget_prepends_a_system_summary_and_keeps_newest():
    m = _msgs(60)
    out = compress_to_budget(m, budget_tokens=400)
    assert out[0]["role"] == "system"           # a summary block leads the context
    assert SUMMARY_PREFIX[:20] in out[0]["content"]
    assert out[-1] == m[-1]                       # newest real turn preserved
    # the recent suffix matches what trim would have kept
    from backend.engine.context import trim_to_budget
    kept = trim_to_budget(m, budget_tokens=400)
    assert out[-len(kept):] == kept


def test_fallback_summary_is_deterministic_and_mentions_dropped_count():
    m = _msgs(60)
    out = compress_to_budget(m, budget_tokens=400)  # no llm_call → deterministic fallback
    summary = out[0]["content"]
    assert "earlier" in summary.lower() or "summar" in summary.lower()
    # it should reference that multiple older turns were condensed
    assert any(ch.isdigit() for ch in summary)


def test_uses_injected_llm_summary_when_available():
    m = _msgs(60)
    calls = {"n": 0}

    def fake_llm(messages, tier=None, system="", fmt=None):
        calls["n"] += 1
        return "USER planned the Aurora launch and discussed Metformin."

    out = compress_to_budget(m, budget_tokens=400, llm_call=fake_llm)
    assert calls["n"] == 1
    assert "Aurora" in out[0]["content"]


def test_falls_back_when_llm_summary_raises():
    m = _msgs(60)

    def boom(messages, tier=None, system="", fmt=None):
        raise RuntimeError("model down")

    out = compress_to_budget(m, budget_tokens=400, llm_call=boom)
    # never blocks — still returns a usable summary block + recent turns
    assert out[0]["role"] == "system"
    assert out[-1] == m[-1]


def test_summary_prefix_frames_as_background_not_instructions():
    assert "not" in SUMMARY_PREFIX.lower()
    assert "instruction" in SUMMARY_PREFIX.lower()
