import json
from pathlib import Path
import httpx
import pytest
from fastapi.testclient import TestClient
from backend.main import app
from backend.marketplace import xlayer


@pytest.fixture(autouse=True)
def network(monkeypatch):
    monkeypatch.setenv("HIRE_NETWORK", "xlayer-testnet")
    monkeypatch.delenv("HOLON_TOKEN", raising=False)
    monkeypatch.delenv("HOLON_READONLY", raising=False)


def test_default_is_current_xlayer_testnet_and_public_rpc_is_not_secret(monkeypatch):
    monkeypatch.delenv("HIRE_NETWORK")
    monkeypatch.setenv("XLAYER_RPC_URL", "https://secret.example/private-token")
    r = TestClient(app).get("/api/xlayer/config")
    assert r.status_code == 200
    assert r.json()["network"]["chainId"] == 1952
    assert "private-token" not in r.text


def test_unknown_network_fails_closed(monkeypatch):
    monkeypatch.setenv("HIRE_NETWORK", "xlayaer")
    r = TestClient(app).get("/api/xlayer/config")
    assert r.status_code == 503


@pytest.mark.parametrize("path", ["/api/market/loop", "/api/market/hire8183", "/api/market/hire8183/submit", "/api/market/negotiate", "/api/market/lookup"])
def test_xlayer_never_falls_back_to_legacy_signing(path):
    assert TestClient(app).post(path, json={}).status_code == 409


def test_legacy_evidence_is_not_exposed():
    r = TestClient(app).get("/api/market/evidence")
    assert r.status_code == 409


def test_payment_rejects_cross_origin_and_form_posts_before_settlement():
    client = TestClient(app)
    assert client.post("/api/agent/research", json={"text": "hello"}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/agent/research", data={"text": "hello"}).status_code == 415


def test_local_signer_is_not_exposed_on_public_networks():
    client = TestClient(app)
    assert client.post("/api/xlayer/local-action", json={"action": "create"}).status_code == 403
    assert client.post("/api/xlayer/local-buyer", json={"text": "hello"}).status_code == 403
    assert client.post("/api/xlayer/execute-job", json={"jobId": "1"}).status_code == 409


def test_existing_bearer_auth_covers_protocol_routes(monkeypatch):
    monkeypatch.setenv("HOLON_TOKEN", "test-only-token")
    assert TestClient(app).post("/api/agent/research", json={"text": "hello"}).status_code == 401


def test_readonly_blocks_local_test_signing(monkeypatch):
    monkeypatch.setenv("HIRE_NETWORK", "local")
    monkeypatch.setenv("HOLON_READONLY", "1")
    assert TestClient(app).post("/api/xlayer/local-action", json={"action": "create"}).status_code == 403


def test_missing_protocol_returns_unavailable_not_fake_success(monkeypatch):
    def absent():
        raise ValueError("Protocol service is not running")
    monkeypatch.setattr(xlayer, "_connection", absent)
    r = TestClient(app).post("/api/agent/research", json={"text": "hello"})
    assert r.status_code == 503 and r.json()["available"] is False


def test_payment_headers_and_http402_are_preserved(monkeypatch):
    class FakeClient:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def request(self, method, url, content, headers):
            assert headers["PAYMENT-SIGNATURE"] == "signed-payload"
            return httpx.Response(402, json={"x402Version": 2}, headers={"PAYMENT-REQUIRED": "challenge"})
    monkeypatch.setattr(xlayer, "_connection", lambda: ("http://127.0.0.1:9402", {"X-Protocol-Token": "secret"}))
    monkeypatch.setattr(xlayer.httpx, "AsyncClient", FakeClient)
    r = TestClient(app).post("/api/agent/research", json={"text": "hello"}, headers={"PAYMENT-SIGNATURE": "signed-payload"})
    assert r.status_code == 402 and r.headers["payment-required"] == "challenge"
    assert "secret" not in r.text


def test_local_signer_rejects_dns_rebinding_hostname(monkeypatch):
    monkeypatch.setenv("HIRE_NETWORK", "local")
    client = TestClient(app, base_url="http://attacker.example")
    assert client.post("/api/xlayer/local-buyer", json={"text": "hello"}).status_code == 403


def test_removed_market_routes_remain_unavailable():
    assert TestClient(app).get("/api/market/agents").status_code == 409


def test_xlayer_blocks_legacy_a2a_signer():
    assert TestClient(app).post("/a2a", json={}).status_code == 409


@pytest.mark.parametrize("route", ["/api/xlayer/execute-job", "/api/agent/research"])
def test_readonly_blocks_provider_signing_and_payment_settlement(monkeypatch, route):
    monkeypatch.setenv("HOLON_READONLY", "1")
    assert TestClient(app).get("/api/xlayer/config").json()["readonly"] is True
    assert TestClient(app).post(route, json={"text": "hello", "jobId": "1"}).status_code == 403


def test_xlayer_blocks_unrelated_legacy_mutations():
    assert TestClient(app).post("/api/reset", json={}).status_code == 409


def test_xlayer_blocks_legacy_skill_execution_with_security_headers():
    r = TestClient(app).post("/api/agents/venus/run", json={})
    assert r.status_code == 409
    assert r.headers["X-Content-Type-Options"] == "nosniff"
