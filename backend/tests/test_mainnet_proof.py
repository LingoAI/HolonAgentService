"""The public USDC result must come from the recorded mainnet deployment."""
import json

from fastapi.testclient import TestClient

from backend.main import app
from backend.marketplace import mainnet_proof


def test_mainnet_record_is_public_only_on_mainnet(monkeypatch):
    client = TestClient(app)
    monkeypatch.setenv("HIRE_NETWORK", "xlayer-testnet")
    assert client.get("/api/xlayer/mainnet-proof").status_code == 404

    monkeypatch.setenv("HIRE_NETWORK", "xlayer-mainnet")
    response = client.get("/api/xlayer/mainnet-proof")
    assert response.status_code == 200
    record = response.json()
    assert record["chainId"] == 196
    assert record["token"]["symbol"] == "USDC"
    assert record["amountRaw"] == "100000"
    assert record["jobId"] == "1"
    assert record["status"] == "Completed"
    assert record["delivery"]["manifestCid"] in record["delivery"]["uri"]
    assert len(record["transactions"]) == 7
    assert "dUSD" not in response.text


def test_mainnet_record_refuses_mismatched_deployment(monkeypatch, tmp_path):
    monkeypatch.setenv("HIRE_NETWORK", "xlayer-mainnet")
    changed = json.loads(mainnet_proof.PROOF.read_text())
    changed["deployment"]["escrow"] = "0x" + "00" * 20
    proof_path = tmp_path / "proof.json"
    proof_path.write_text(json.dumps(changed))
    monkeypatch.setattr(mainnet_proof, "PROOF", proof_path)
    assert TestClient(app).get("/api/xlayer/mainnet-proof").status_code == 503


def test_live_verification_checks_real_receipt_events(monkeypatch):
    monkeypatch.setenv("HIRE_NETWORK", "xlayer-mainnet")
    proof, manifest, txs = mainnet_proof._record()
    escrow = manifest["escrow"]
    job = f"0x{int(proof['jobId']):064x}"
    buyer = mainnet_proof._topic_address(proof["roles"]["buyer"])
    provider = mainnet_proof._topic_address(proof["roles"]["provider"])
    evaluator = mainnet_proof._topic_address(proof["roles"]["facilitator"])
    amount = f"0x{int(proof['amountRaw']):064x}"
    logs = {
        "fund-job": [{"address": escrow, "topics": [mainnet_proof.FUNDED, job, buyer], "data": amount}],
        "submit-delivery": [{"address": escrow, "topics": [mainnet_proof.DELIVERY_URI, job,
                                                               proof["delivery"]["digest"]], "data": "0x"}],
        "complete-job": [{"address": escrow, "topics": [mainnet_proof.RELEASED, job, provider], "data": amount},
                         {"address": escrow, "topics": [mainnet_proof.COMPLETED, job, evaluator], "data": "0x"}],
    }

    async def fake_rpc(_client, method, params, _request_id):
        if method == "eth_chainId":
            return hex(196)
        assert method == "eth_getTransactionReceipt"
        step = next(step for step in logs if txs[step]["hash"] == params[0])
        return {"status": "0x1", "to": escrow, "transactionHash": params[0],
                "blockNumber": hex(txs[step]["blockNumber"]), "logs": logs[step]}

    monkeypatch.setattr(mainnet_proof, "_rpc_call", fake_rpc)
    response = TestClient(app).get("/api/xlayer/mainnet-proof/verify")
    assert response.status_code == 200
    assert response.json()["verified"] is True

    logs["complete-job"][0]["data"] = "0x0"
    response = TestClient(app).get("/api/xlayer/mainnet-proof/verify")
    assert response.status_code == 409
    assert response.json()["verified"] is False
