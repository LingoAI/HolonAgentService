# holon/backend/tests/test_api.py
import importlib
from fastapi.testclient import TestClient

def _client(tmp_path, monkeypatch):
    from backend import config
    from backend.engine import rag, memory
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    rag._get_chroma.cache_clear()      # rebuild chroma against the tmp DATA_DIR
    memory._build.cache_clear()        # rebuild mem0 against the tmp DATA_DIR
    import backend.main as main
    importlib.reload(main)
    return TestClient(main.app)

def test_status_ok_even_without_ollama(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.get("/api/status")
    assert r.status_code == 200 and "tier" in r.json()

def test_ingest_then_graph_and_stats(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    import backend.main as main
    # keep the test hermetic — don't let ingest's extractor hit the network
    monkeypatch.setattr(main.ONTO, "extract_and_add", lambda *a, **k: [])
    r = c.post("/api/ingest", json={"title": "Notes", "text": "Project Aurora is a drone fleet.", "tag": "work"})
    assert r.status_code == 200 and r.json()["chunks"] >= 1
    r = c.get("/api/graph")
    assert r.status_code == 200 and "nodes" in r.json()
    r = c.get("/api/stats")
    assert r.status_code == 200 and {"memories", "docs", "nodes", "edges"} <= set(r.json())

def test_tier_switch(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.post("/api/tier", json={"tier": "local"})
    assert r.status_code == 200 and r.json()["tier"] == "local"
