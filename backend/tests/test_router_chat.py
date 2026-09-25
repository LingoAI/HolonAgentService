# holon/backend/tests/test_router_chat.py
import importlib
from fastapi.testclient import TestClient


def _client(tmp_path, monkeypatch):
    from backend import config
    from backend.engine import rag, memory
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    rag._get_chroma.cache_clear()
    memory._build.cache_clear()
    import backend.main as main
    importlib.reload(main)
    return TestClient(main.app)


def test_status_exposes_selection(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.get("/api/status")
    assert r.status_code == 200
    assert "selection" in r.json()


def test_tier_accepts_auto(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.post("/api/tier", json={"tier": "auto"})
    assert r.status_code == 200 and r.json()["tier"] == "auto"
    s = c.get("/api/status").json()
    assert s["selection"] == "auto"
    assert s["model"] == "auto"
    assert "Auto" in s["label"]


def test_tier_rejects_bad(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.post("/api/tier", json={"tier": "frontier"})
    assert r.status_code == 400


def test_chat_uses_router(tmp_path, monkeypatch):
    """Under "auto", a simple query routes to local; the route SSE event carries
    the decision. We stub the llm + extractor so nothing hits the network."""
    c = _client(tmp_path, monkeypatch)
    import backend.main as main
    from backend.engine import router
    main.config.set_tier("auto")
    monkeypatch.setattr(main.llm, "chat_stream", lambda *a, **k: iter(["ok"]))
    monkeypatch.setattr(main.memory, "mem_add", lambda *a, **k: None)
    monkeypatch.setattr(main.ONTO, "extract_and_add", lambda *a, **k: [])
    monkeypatch.setattr(main.context, "build_system", lambda *a, **k: "sys")

    calls = {}
    real_route = router.route
    def spy(query, sel, onto=None):
        d = real_route(query, sel, onto)
        calls["decision"] = d
        return d
    monkeypatch.setattr(main.router, "route", spy)

    with c.stream("POST", "/api/chat", json={"message": "hi"}) as resp:
        body = "".join(resp.iter_text())
    assert "event: route" in body
    assert "event: paths" in body
    assert calls["decision"]["tier"] == "local"
    assert calls["decision"]["auto"] is True
