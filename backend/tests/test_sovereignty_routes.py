# holon/backend/tests/test_sovereignty_routes.py
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
    # seed a couple of typed facts on the live ONTO
    main.ONTO.upsert_relation("You", "takes", "Metformin", source="seed",
                              node_types={"You": "Person", "Metformin": "Medication"})
    main.ONTO.upsert_relation("You", "works_on", "LingoAI", source="seed",
                              node_types={"You": "Person", "LingoAI": "Org"})
    return TestClient(main.app), main


def test_webid_route(tmp_path, monkeypatch):
    c, _ = _client(tmp_path, monkeypatch)
    r = c.get("/api/webid")
    assert r.status_code == 200 and r.json()["name"] == "You"


def test_pod_export_and_import(tmp_path, monkeypatch):
    c, _ = _client(tmp_path, monkeypatch)
    r = c.get("/api/pod/export")
    assert r.status_code == 200
    b = r.json()
    assert {"webid", "turtle", "jsonld"} <= set(b)
    r2 = c.post("/api/pod/import", json={"bundle": b})
    assert r2.status_code == 200 and r2.json()["count"] >= 1


def test_grant_share_then_revoke_denies(tmp_path, monkeypatch):
    c, _ = _client(tmp_path, monkeypatch)
    r = c.post("/api/access", json={"grantee": "Dr. Smith", "scopes": ["Medication"]})
    assert r.status_code == 200
    g = r.json()
    token, gid = g["token"], g["id"]

    # grant appears in the list
    lst = c.get("/api/access").json()
    assert any(x["id"] == gid for x in lst)

    # share shows only the in-scope slice
    share = c.get(f"/api/share/{token}").json()
    ids = {n["data"]["id"] for n in share["nodes"]}
    assert "Metformin" in ids and "You" in ids
    assert "LingoAI" not in ids

    # revoke -> share denied
    rr = c.post("/api/access/revoke", json={"id": gid})
    assert rr.status_code == 200
    denied = c.get(f"/api/share/{token}").json()
    assert denied.get("error") == "revoked" and not denied.get("nodes")
