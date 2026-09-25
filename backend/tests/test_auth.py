"""Bearer auth: off by default, enforced on /api/* when HOLON_TOKEN is set."""
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)


def test_open_when_no_token(monkeypatch):
    monkeypatch.delenv("HOLON_TOKEN", raising=False)
    assert client.get("/api/status").status_code == 200


def test_401_without_bearer(monkeypatch):
    monkeypatch.setenv("HOLON_TOKEN", "s3cret")
    r = client.get("/api/status")
    assert r.status_code == 401
    assert r.json() == {"error": "unauthorized"}


def test_200_with_bearer(monkeypatch):
    monkeypatch.setenv("HOLON_TOKEN", "s3cret")
    r = client.get("/api/status", headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 200


def test_static_spa_not_gated(monkeypatch):
    monkeypatch.setenv("HOLON_TOKEN", "s3cret")
    assert client.get("/").status_code == 200


def test_401_still_carries_security_headers(monkeypatch):
    monkeypatch.setenv("HOLON_TOKEN", "s3cret")
    r = client.get("/api/status")
    assert r.status_code == 401
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert "Content-Security-Policy" in r.headers
