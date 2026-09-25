import hashlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.marketplace import mvp

BUYER = "0x" + "11" * 20
PROVIDER = "0x" + "22" * 20
EVALUATOR = "0x" + "33" * 20
OUTSIDER = "0x" + "44" * 20
PROVIDER_TWO = "0x" + "66" * 20


class FakeStorage:
    configured = True
    gateways = ["https://gateway.example/ipfs/"]

    def __init__(self, root):
        self.root = Path(root)

    def persist_raw(self, key, name, raw):
        path = self.root / key / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.read_bytes() != raw:
            raise RuntimeError("changed bytes")
        path.write_bytes(raw)
        return path

    def pin_bytes(self, name, raw):
        marker = "a" if name.endswith(".md") else "c"
        return "b" + marker * 58

    def export_pair(self, key, file_raw, manifest_raw, file_cid, manifest_cid):
        path = self.root / f"{key}.car"
        path.write_bytes(b"car")
        return path

    def gateway_urls(self, cid):
        return [self.gateways[0] + cid]

    def read_gateway(self, cid, expected_sha256=None):
        raise AssertionError("not used in API workflow test")


@pytest.fixture
def market(monkeypatch, tmp_path):
    monkeypatch.setenv("HIRE_NETWORK", "local")
    monkeypatch.setenv("MVP_PUBLIC_ORIGIN", "http://testserver")
    monkeypatch.setenv("MVP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("HOLON_READONLY", raising=False)
    # The API test uses a fake protocol, so it must not depend on a local
    # deployment manifest left behind by a developer's private checkout.
    local_deployment = {"identityRegistry": "0x" + "55" * 20,
                        "escrow": "0x" + "55" * 20,
                        "token": {"symbol": "dUSD", "decimals": 6, "testToken": True}}
    monkeypatch.setattr(mvp.xlayer, "configuration", lambda: {
        "network": {"name": "local", "chainId": 31337}, "deployment": local_deployment})
    mvp._store_cache.clear()
    mvp._storage_cache.clear()
    fake_storage = FakeStorage(tmp_path / "objects")
    monkeypatch.setattr(mvp, "storage", lambda: fake_storage)

    async def protocol(path, payload=None, method="POST", timeout=125):
        payload = payload or {}
        if path == "/verify-message":
            return {"ok": True, "address": payload["message"].splitlines()[1]}
        if path == "/keccak":
            return {"ok": True, "keccak256": "0x" + hashlib.sha256(payload["bytesBase64"].encode()).hexdigest()}
        if path == "/registry-owner":
            owners = {"7": PROVIDER, "8": PROVIDER_TWO}
            assert payload["agentId"] in owners
            return {"ok": True, "agentId": payload["agentId"], "owner": owners[payload["agentId"]],
                    "metadataURI": "ipfs://b" + "d" * 58}
        if path == "/verify-typed-data":
            return {"ok": True, "address": payload["value"]["provider"]}
        if path == "/prepare":
            return {"ok": True, "transaction": {"to": "0x" + "55" * 20, "data": "0x1234", "value": "0x0", "chainId": "0x7a69"}}
        if path == "/receipt":
            order = mvp.store().list_orders()[0]
            task = mvp.store().task(order["task_uid"])
            application = mvp.store().application(order["application_id"])
            return {"ok": True, "pending": False, "status": 1, "blockNumber": 9, "blockHash": "0x" + "99" * 32,
                    "from": order["buyer"], "to": "0x" + "55" * 20, "data": "0x1234", "value": "0",
                    "events": [{"name": "JobCreated", "args": {"jobId": "42", "client": order["buyer"],
                                "provider": order["provider"], "evaluator": order["evaluator"],
                                "expiredAt": str(order["expired_at"]), "description": mvp._description(task, application)}},
                               {"name": "AgentLinked", "args": {"jobId": "42", "agentId": "7", "provider": order["provider"]}}]}
        if path == "/state":
            order = mvp.store().list_orders()[0]
            return {"ok": True, "jobs": [{"id": "42", "client": order["buyer"], "provider": order["provider"],
                    "evaluator": order["evaluator"], "expiredAt": order["expired_at"], "agentId": "7",
                    "budgetRaw": order["amount_raw"], "status": "Funded"}]}
        raise AssertionError(path)

    monkeypatch.setattr(mvp.xlayer, "protocol_json", protocol)
    yield {"buyer": TestClient(app), "provider": TestClient(app), "provider_two": TestClient(app),
           "evaluator": TestClient(app),
           "outsider": TestClient(app), "storage": fake_storage}
    mvp._store_cache.clear()


def login(client, wallet):
    challenge = client.post("/api/xlayer/mvp/auth/challenge", json={"address": wallet})
    assert challenge.status_code == 200, challenge.text
    doc = challenge.json()
    assert "Chain ID: 31337" in doc["message"]
    verified = client.post("/api/xlayer/mvp/auth/verify", json={"nonce": doc["nonce"], "signature": "0x" + "ab" * 65})
    assert verified.status_code == 200, verified.text
    assert client.get("/api/xlayer/mvp/auth/session").json()["address"] == wallet


def test_full_market_api_enforces_ownership_signature_freeze_and_delivery_recovery(market):
    buyer, provider, outsider = market["buyer"], market["provider"], market["outsider"]
    login(buyer, BUYER)
    login(provider, PROVIDER)
    login(outsider, OUTSIDER)

    profile = provider.post("/api/xlayer/mvp/providers", json={"agentId": "7", "name": "FAQ Writer",
                            "introduction": "I write public community FAQ documents.",
                            "metadataURI": "ipfs://b" + "d" * 58,
                            "registrationTxHash": "0x" + "01" * 32})
    assert profile.status_code == 200, profile.text
    assert buyer.get("/api/xlayer/mvp/providers").json()["providers"][0]["owner"] == PROVIDER

    task = buyer.post("/api/xlayer/mvp/tasks", json={"title": "Write the OKX community FAQ",
        "communityIntroduction": "A public builder community on X Layer.",
        "confirmedFacts": ["The settlement network is X Layer Testnet."],
        "publicSources": ["https://example.test/community"], "targetAudience": "New community members",
        "acceptanceChecklist": ["Include an introduction", "Include at least five FAQ entries"],
        "amountRaw": "2500000", "evaluator": EVALUATOR,
        "expiredAt": mvp.now_s() + 7200})
    assert task.status_code == 200, task.text
    task_doc = task.json()["task"]
    assert task_doc["status"] == "open" and task_doc["amount_raw"] == "2500000"

    typed = provider.post(f"/api/xlayer/mvp/tasks/{task_doc['uid']}/application-data", json={"agentId": "7"})
    assert typed.status_code == 200, typed.text
    typed_data = typed.json()["typedData"]
    application = provider.post(f"/api/xlayer/mvp/tasks/{task_doc['uid']}/applications", json={
        "agentId": "7", "applicationNonce": typed_data["message"]["applicationNonce"],
        "validUntil": typed_data["message"]["validUntil"], "signature": "0x" + "ef" * 65})
    assert application.status_code == 200, application.text
    app_id = application.json()["application"]["id"]

    assert outsider.post(f"/api/xlayer/mvp/tasks/{task_doc['uid']}/close", json={}).status_code == 409
    selected = buyer.post(f"/api/xlayer/mvp/tasks/{task_doc['uid']}/select", json={"applicationId": app_id})
    assert selected.status_code == 200, selected.text
    order = selected.json()["order"]
    assert buyer.post(f"/api/xlayer/mvp/tasks/{task_doc['uid']}/select", json={"applicationId": app_id}).status_code == 409

    intent = buyer.post("/api/xlayer/mvp/intents", json={"action": "create", "objectId": order["id"],
                                                        "idempotencyKey": "create:task:one"})
    assert intent.status_code == 200, intent.text
    intent_id = intent.json()["intent"]["id"]
    tx_hash = "0x" + "77" * 32
    assert buyer.post(f"/api/xlayer/mvp/intents/{intent_id}/broadcast", json={"txHash": tx_hash}).status_code == 200
    assert buyer.post(f"/api/xlayer/mvp/intents/{intent_id}/broadcast", json={"txHash": "0x" + "66" * 32}).status_code == 400
    reconciled = buyer.post(f"/api/xlayer/mvp/intents/{intent_id}/reconcile", json={})
    assert reconciled.status_code == 200, reconciled.text
    assert buyer.get(f"/api/xlayer/mvp/orders/{order['id']}").json()["order"]["job_id"] == "42"

    denied = outsider.post(f"/api/xlayer/mvp/orders/{order['id']}/delivery", json={"document": "# stolen"})
    assert denied.status_code == 403
    delivery = provider.post(f"/api/xlayer/mvp/orders/{order['id']}/delivery", json={
        "document": "# Community introduction\n\n## FAQ\n\n### What network?\n\nX Layer Testnet."})
    assert delivery.status_code == 200, delivery.text
    evidence = delivery.json()["delivery"]
    assert evidence["stage"] == "ready" and evidence["uri"].startswith("ipfs://b")
    repeated = provider.post(f"/api/xlayer/mvp/orders/{order['id']}/delivery", json={
        "document": "# Community introduction\n\n## FAQ\n\n### What network?\n\nX Layer Testnet."})
    assert repeated.status_code == 200 and repeated.json()["delivery"]["manifest_cid"] == evidence["manifest_cid"]
    changed = provider.post(f"/api/xlayer/mvp/orders/{order['id']}/delivery", json={"document": "# changed"})
    assert changed.status_code == 409
    assert provider.get(f"/api/xlayer/mvp/orders/{order['id']}/car").content == b"car"


def test_siwe_wrong_origin_nonce_replay_and_other_wallet_profile_are_rejected(market):
    provider = market["provider"]
    bad = provider.post("/api/xlayer/mvp/auth/challenge", json={"address": PROVIDER}, headers={"Host": "evil.test"})
    assert bad.status_code == 400
    challenge = provider.post("/api/xlayer/mvp/auth/challenge", json={"address": PROVIDER}).json()
    first = provider.post("/api/xlayer/mvp/auth/verify", json={"nonce": challenge["nonce"], "signature": "0x" + "ab" * 65})
    assert first.status_code == 200
    replay = provider.post("/api/xlayer/mvp/auth/verify", json={"nonce": challenge["nonce"], "signature": "0x" + "ab" * 65})
    assert replay.status_code == 401
    # Protocol owner is PROVIDER; an OUTSIDER session cannot claim agent #7.
    outsider = market["outsider"]
    login(outsider, OUTSIDER)
    claimed = outsider.post("/api/xlayer/mvp/providers", json={"agentId": "7", "name": "Fake",
                            "introduction": "Not the owner", "metadataURI": "ipfs://b" + "d" * 58})
    assert claimed.status_code == 403


def test_two_independent_provider_wallets_can_apply_but_buyer_selects_only_one(market):
    buyer, first, second = market["buyer"], market["provider"], market["provider_two"]
    login(buyer, BUYER)
    login(first, PROVIDER)
    login(second, PROVIDER_TWO)
    for client, owner, agent in ((first, PROVIDER, "7"), (second, PROVIDER_TWO, "8")):
        saved = client.post("/api/xlayer/mvp/providers", json={"agentId": agent, "name": f"Writer {agent}",
                            "introduction": f"Independent provider wallet {owner} for the public FAQ template.",
                            "metadataURI": "ipfs://b" + "d" * 58})
        assert saved.status_code == 200, saved.text
    task = buyer.post("/api/xlayer/mvp/tasks", json={"title": "Choose one of two FAQ providers",
        "communityIntroduction": "A public test of independent fixed-bounty applications.",
        "confirmedFacts": ["Two separate provider wallets may apply."],
        "publicSources": ["https://example.test/two-providers"], "targetAudience": "Reviewers",
        "acceptanceChecklist": ["Include an introduction", "Include five FAQ entries"],
        "amountRaw": "1000000", "evaluator": EVALUATOR, "expiredAt": mvp.now_s() + 7200}).json()["task"]
    applications = []
    for client, agent in ((first, "7"), (second, "8")):
        typed = client.post(f"/api/xlayer/mvp/tasks/{task['uid']}/application-data", json={"agentId": agent}).json()["typedData"]
        submitted = client.post(f"/api/xlayer/mvp/tasks/{task['uid']}/applications", json={"agentId": agent,
            "applicationNonce": typed["message"]["applicationNonce"], "validUntil": typed["message"]["validUntil"],
            "signature": "0x" + "ef" * 65})
        assert submitted.status_code == 200, submitted.text
        applications.append(submitted.json()["application"])
    assert len(buyer.get(f"/api/xlayer/mvp/tasks/{task['uid']}").json()["applications"]) == 2
    assert buyer.post(f"/api/xlayer/mvp/tasks/{task['uid']}/select",
                      json={"applicationId": applications[0]["id"]}).status_code == 200
    assert buyer.post(f"/api/xlayer/mvp/tasks/{task['uid']}/select",
                      json={"applicationId": applications[1]["id"]}).status_code == 409


def test_mainnet_canary_requires_explicit_profile_reviewed_usdc_and_frozen_caps(monkeypatch):
    record = {"deploymentMode": "mainnet-canary", "canaryVersion": 2, "mvpVersion": 1,
              "escrowArtifact": "MainnetCanaryEscrow", "escrow": "0x" + "55" * 20,
              "token": {"address": mvp.MAINNET_USDC, "name": "USDC", "symbol": "USDC",
                        "decimals": 6, "version": "2", "testToken": False},
              "limits": {"maxBudgetRaw": "1000000", "maxTotalEscrowRaw": "5000000"},
              "applicationDomain": {"name": "LingoAI Mainnet Canary Market", "version": "2"}}
    monkeypatch.setattr(mvp.xlayer, "configuration", lambda: {"network": {"name": "xlayer-mainnet", "chainId": 196},
                                                               "deployment": record})
    monkeypatch.delenv("MVP_MAINNET_CANARY", raising=False)
    with pytest.raises(ValueError, match="explicit capped canary"):
        mvp.deployment()
    monkeypatch.setenv("MVP_MAINNET_CANARY", "1")
    assert mvp.deployment()[1] is record
    assert mvp.amount_raw("1000000", record) == "1000000"
    with pytest.raises(ValueError, match="at or below 1000000"):
        mvp.amount_raw("1000001", record)
    typed = mvp.typed_application(record, {"chain_id": 196, "uid": "task-1", "task_hash": "0x" + "11" * 32,
                                             "amount_raw": "100000", "evaluator": EVALUATOR, "expired_at": 2000000000},
                                    PROVIDER, "7", "0x" + "22" * 32, 1999999000)
    assert typed["domain"] == {"name": "LingoAI Mainnet Canary Market", "version": "2", "chainId": 196,
                                "verifyingContract": record["escrow"]}
