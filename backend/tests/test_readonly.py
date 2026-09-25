# holon/backend/tests/test_readonly.py
"""HOLON_READONLY=1 is the public-instance profile: everything that writes
the twin answers 403, everything a judge needs still answers. These are the
routes the earlier profile missed."""
import pytest
from fastapi.testclient import TestClient

from backend import config, main


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("HOLON_READONLY", "1")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    return TestClient(main.app)


@pytest.mark.parametrize("path, body", [
    ("/api/chat", {"message": "hi"}),                 # writes history, memory, ontology
    ("/api/pod/import", {"bundle": {}}),              # rewrites the graph
    ("/api/holon/preferences", {"budget_u": 5}),      # one shared file
    ("/api/backup", {}),
    ("/api/bridge/attest", {"scope": "x"}),
    ("/api/reset", {}), ("/api/ingest", {"text": "x"}), ("/api/seed", {}),
])
def test_write_routes_answer_403(client, path, body):
    r = client.post(path, json=body)
    assert r.status_code == 403, path
    assert r.json()["error"] == "read-only deployment"


def test_reads_work_and_removed_market_is_closed(client):
    assert client.get("/api/status").status_code == 200
    assert client.get("/health").json()["ok"] is True
    assert client.get("/api/holon/preferences").status_code == 200
    assert client.get("/api/market/jobs").status_code == 409
