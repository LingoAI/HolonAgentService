# holon/backend/tests/test_context_budget.py
from backend.engine.context import trim_to_budget, estimate_tokens

def _msgs(n):
    return [{"role": "user" if i % 2 == 0 else "assistant", "content": f"message number {i} " * 20}
            for i in range(n)]

def test_small_history_untouched():
    m = _msgs(4)
    assert trim_to_budget(m, budget_tokens=100000) == m

def test_trims_oldest_first_when_over_budget():
    m = _msgs(60)
    out = trim_to_budget(m, budget_tokens=400)
    assert len(out) < len(m)
    assert out[-1] == m[-1]                      # newest kept
    assert out == m[-len(out):]                  # a suffix (oldest dropped)

def test_always_keeps_at_least_recent():
    m = _msgs(60)
    out = trim_to_budget(m, budget_tokens=1, protect_recent=4)
    assert len(out) >= 4

def test_estimate_monotonic():
    assert estimate_tokens("hi") < estimate_tokens("hi there friend " * 10)
