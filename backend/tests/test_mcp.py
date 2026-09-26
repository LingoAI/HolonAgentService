import httpx
from fastapi.testclient import TestClient
from backend.main import app
from backend.marketplace import xlayer


def test_official_evidence_keeps_official_usdt_separate_from_custom_escrow(monkeypatch):
    monkeypatch.delenv("HOLON_TOKEN", raising=False)
    response = TestClient(app).get("/api/xlayer/official-evidence")
    assert response.status_code == 200
    data = response.json()
    assert data["agent"]["id"] == "13847"
    assert {s["type"] for s in data["services"]} == {"A2MCP", "A2A"}
    assert all(s["currency"] == "USDT" for s in data["services"])
    assert data["evidence"]["a2mcp"]["replayWithoutDuplicateCharge"]
    assert "current review status" in data["listingNote"]


def test_mcp_proxy_preserves_negotiation_and_works_in_readonly_mode(monkeypatch):
    monkeypatch.setenv("HIRE_NETWORK", "xlayer-mainnet")
    monkeypatch.setenv("HOLON_READONLY", "1")
    monkeypatch.delenv("HOLON_TOKEN", raising=False)
    class FakeClient:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def request(self, method, url, content, headers):
            assert url.endswith("/mcp")
            assert headers["accept"] == "application/json, text/event-stream"
            assert headers["mcp-protocol-version"] == "2025-11-25"
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"tools": []}})
    monkeypatch.setattr(xlayer, "_connection", lambda: ("http://127.0.0.1:9402", {"X-Protocol-Token": "private"}))
    monkeypatch.setattr(xlayer.httpx, "AsyncClient", FakeClient)
    r = TestClient(app).post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                             headers={"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"})
    assert r.status_code == 200
    assert "private" not in r.text


def test_mcp_rejects_untrusted_origins_forms_and_oversized_bodies(monkeypatch):
    monkeypatch.setenv("HIRE_NETWORK", "xlayer-mainnet")
    monkeypatch.setenv("MVP_PUBLIC_ORIGIN", "https://service.example")
    monkeypatch.delenv("HOLON_TOKEN", raising=False)
    monkeypatch.setattr(xlayer, "_connection", lambda: ("http://127.0.0.1:9402", {}))
    client = TestClient(app, base_url="https://service.example")
    for origin in ["https://evil.example", "http://service.example", "null"]:
        assert client.post("/mcp", json={}, headers={"Origin": origin}).status_code == 403
    assert client.post("/mcp", data={"message": "hello"}).status_code == 415
    assert client.post("/mcp", json={"text": "a" * 32769}).status_code == 413


def test_mcp_obeys_optional_operator_auth(monkeypatch):
    monkeypatch.setenv("HOLON_TOKEN", "operator-only")
    assert TestClient(app).post("/mcp", json={}).status_code == 401
    assert TestClient(app).post("/verify", json={}).status_code == 401


def test_verification_rest_route_is_public_readonly_and_preserves_reports(monkeypatch):
    monkeypatch.setenv("HOLON_READONLY", "1")
    monkeypatch.delenv("HOLON_TOKEN", raising=False)
    async def proxy(path, request=None, method="GET"):
        from fastapi.responses import JSONResponse
        assert path == "/verify-delivery" and method == "POST"
        return JSONResponse({"ok": True, "verified": False, "verificationStatus": "not_found"})
    monkeypatch.setattr(xlayer, "proxy", proxy)
    r = TestClient(app).post("/api/xlayer/verify-delivery", json={"transactionHash": "0x" + "a" * 64})
    assert r.status_code == 200 and r.json()["verified"] is False


def test_verify_alias_preserves_payment_headers_and_cannot_spoof_internal_route(monkeypatch):
    monkeypatch.setenv("HIRE_NETWORK", "xlayer-mainnet")
    monkeypatch.delenv("HOLON_TOKEN", raising=False)
    class FakeClient:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def request(self, method, url, content, headers):
            assert url.endswith("/verify-delivery")
            assert headers["X-Verification-Path"] == "/verify"
            assert headers["PAYMENT-SIGNATURE"] == "buyer-signature"
            assert headers["X-Protocol-Token"] == "operator-token"
            return httpx.Response(402, json={"x402Version": 2}, headers={"PAYMENT-REQUIRED": "challenge"})
    monkeypatch.setattr(xlayer, "_connection", lambda: ("http://127.0.0.1:9402", {"X-Protocol-Token": "operator-token"}))
    monkeypatch.setattr(xlayer.httpx, "AsyncClient", FakeClient)
    client = TestClient(app)
    r = client.post("/verify", json={"txHash": "0x" + "a" * 64}, headers={
        "PAYMENT-SIGNATURE": "buyer-signature", "X-Verification-Path": "/verify-internal", "X-Protocol-Token": "spoofed"})
    assert r.status_code == 402 and r.headers["payment-required"] == "challenge"
    assert client.post("/verify-internal", json={}).status_code in (404, 409)
