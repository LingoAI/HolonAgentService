# holon/backend/tests/test_trajectory.py
"""Trajectory / audit trail: an append-only, secret-scrubbed JSONL record of every
chat turn — which tier ran and why, token cost, latency, facts extracted, errors.
The backbone of "trustworthy forever": you can always see what the twin decided.
Harvested from hermes-agent's trajectory concept (zero new deps)."""
import importlib
from fastapi.testclient import TestClient
from backend import config
from backend import trajectory


def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)


def test_log_then_read_roundtrip(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    trajectory.log_turn({"tier": "local", "query": "hi"})
    rows = trajectory.read_trajectory()
    assert len(rows) == 1
    assert rows[0]["tier"] == "local" and rows[0]["query"] == "hi"
    assert rows[0]["ts"]  # a timestamp is stamped automatically


def test_appends_in_order(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    trajectory.log_turn({"query": "first"})
    trajectory.log_turn({"query": "second"})
    rows = trajectory.read_trajectory()
    assert [r["query"] for r in rows] == ["first", "second"]


def test_secrets_are_scrubbed(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    trajectory.log_turn({"query": "hi", "api_key": "sk-supersecret"})
    rows = trajectory.read_trajectory()
    assert rows[0]["api_key"] == "***"


def test_read_limit_returns_last_n(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    for i in range(5):
        trajectory.log_turn({"query": f"q{i}"})
    rows = trajectory.read_trajectory(limit=2)
    assert [r["query"] for r in rows] == ["q3", "q4"]


def test_corrupt_line_is_skipped(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    trajectory.log_turn({"query": "good"})
    (tmp_path / "trajectory.jsonl").open("a").write("this is not json\n")
    rows = trajectory.read_trajectory()
    assert [r["query"] for r in rows] == ["good"]  # bad line dropped, good kept


# ---- chat loop writes a trajectory record, exposed at /api/trajectory -------

def _client(tmp_path, monkeypatch):
    from backend.engine import rag, memory
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    rag._get_chroma.cache_clear()
    memory._build.cache_clear()
    import backend.main as main
    importlib.reload(main)
    return TestClient(main.app)


def test_chat_turn_is_recorded(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    import backend.main as main
    monkeypatch.setattr(main.llm, "chat_stream", lambda *a, **k: iter(["hello"]))
    monkeypatch.setattr(main.memory, "mem_add", lambda *a, **k: None)
    monkeypatch.setattr(main.ONTO, "extract_and_add", lambda *a, **k: [])
    monkeypatch.setattr(main.context, "build_system", lambda *a, **k: "sys")

    with c.stream("POST", "/api/chat", json={"message": "remember this"}) as resp:
        "".join(resp.iter_text())

    r = c.get("/api/trajectory")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) >= 1
    last = rows[-1]
    assert last["query"] == "remember this"
    assert "tier" in last and "latency_ms" in last
