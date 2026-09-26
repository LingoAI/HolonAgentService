"""Read-only public evidence for the completed X Layer mainnet USDC order."""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

ROOT = Path(__file__).resolve().parents[2]
PROOF = ROOT / "docs/evidence/mainnet-native-usdc-proof-2026-09-22.json"
MANIFEST = ROOT / "contracts/deployments/xlayer-mainnet-native-usdc-canary.json"
RPC_URL = "https://rpc.xlayer.tech"
EXPLORER = "https://www.okx.com/web3/explorer/xlayer"
ROUTER = APIRouter(prefix="/api/xlayer/mainnet-proof")

FUNDED = "0xe3fbcc1ea1bdc559ec7f0347efde7655e58b5f45a30b0e4470a583c3ef5496b3"
DELIVERY_URI = "0x10d6c1c832f2966d75eb4acbc64c8c506e3e209894cd514514466a46ced65c40"
RELEASED = "0x21d71db5be59bb9fa133895586b7404307dd33fb93b16db09dc6f1d9d7d231b0"
COMPLETED = "0x0fd54bd364fa9e67f17b091aefe930932c09fe7651cf5ad02c71a418f3341444"
STEPS = ("register-agent", "create-agent-job", "set-budget", "approve-exact-usdc",
         "fund-job", "submit-delivery", "complete-job")


def _record():
    proof = json.loads(PROOF.read_text())
    manifest = json.loads(MANIFEST.read_text())
    addresses = ("escrow", "identityRegistry")
    if (proof.get("network") != "xlayer-mainnet" or proof.get("chainId") != 196 or
            proof.get("status") != "Completed" or proof.get("deploymentId") != manifest.get("deploymentId") or
            manifest.get("deploymentMode") != "mainnet-canary" or manifest.get("chainId") != 196 or
            manifest.get("token", {}).get("symbol") != "USDC" or manifest.get("token", {}).get("testToken") is not False or
            any(str(proof.get("deployment", {}).get(key, "")).lower() != str(manifest.get(key, "")).lower()
                for key in addresses) or
            str(proof.get("deployment", {}).get("token", "")).lower() !=
            str(manifest.get("token", {}).get("address", "")).lower()):
        raise ValueError("Mainnet proof and deployment manifest disagree")
    amount = int(proof["amountRaw"])
    if amount <= 0 or amount > int(manifest["limits"]["maxBudgetRaw"]):
        raise ValueError("Mainnet proof amount exceeds the canary limit")
    transactions = {row["step"]: row for row in proof["transactions"]}
    if any(step not in transactions or not str(transactions[step].get("hash", "")).startswith("0x")
           or len(transactions[step]["hash"]) != 66 for step in STEPS):
        raise ValueError("Mainnet proof is missing a required transaction")
    if proof.get("delivery", {}).get("uri") != "ipfs://" + proof.get("ipfs", {}).get("manifestCid", ""):
        raise ValueError("Mainnet delivery URI does not match its manifest CID")
    return proof, manifest, transactions


def _public_record():
    proof, manifest, transactions = _record()
    ipfs = proof["ipfs"]
    return {"ok": True, "network": "xlayer-mainnet", "chainId": 196, "explorer": EXPLORER,
            "status": "Completed", "recordedAt": proof["completedAt"], "deploymentId": proof["deploymentId"],
            "escrow": manifest["escrow"], "registry": manifest["identityRegistry"],
            "token": {"address": manifest["token"]["address"], "symbol": "USDC", "decimals": 6},
            "limits": manifest["limits"], "agentId": proof["agentId"], "jobId": proof["jobId"],
            "amountRaw": proof["amountRaw"], "buyer": proof["roles"]["buyer"],
            "provider": proof["roles"]["provider"], "evaluator": proof["roles"]["facilitator"],
            "transactions": [{"step": step, "hash": transactions[step]["hash"],
                              "blockNumber": transactions[step]["blockNumber"]} for step in STEPS],
            "delivery": {"uri": proof["delivery"]["uri"], "digest": proof["delivery"]["digest"],
                         "manifestCid": ipfs["manifestCid"], "manifestSha256": ipfs["manifest"]["sha256"],
                         "documentCid": ipfs["documentCid"], "documentSha256": ipfs["document"]["sha256"]}}


def _enabled():
    return os.getenv("HIRE_NETWORK") == "xlayer-mainnet"


@ROUTER.get("")
def record_route():
    if not _enabled():
        return JSONResponse({"ok": False, "error": "Mainnet proof is available on the mainnet site"}, status_code=404)
    try:
        return JSONResponse(_public_record(), headers={"Cache-Control": "no-store"})
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return JSONResponse({"ok": False, "error": str(exc)[:200]}, status_code=503)


async def _rpc_call(client, method, params, request_id):
    response = await client.post(os.getenv("XLAYER_MAINNET_RPC_URL") or RPC_URL,
                                 json={"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
    response.raise_for_status()
    data = response.json()
    if data.get("error") or "result" not in data:
        raise ValueError(f"Mainnet RPC rejected {method}")
    return data["result"]


def _event(receipt, address, signature, topics, amount=None):
    for log in receipt.get("logs", []):
        actual = [str(value).lower() for value in log.get("topics", [])]
        if (str(log.get("address", "")).lower() == address.lower() and
                actual[:len(topics) + 1] == [signature, *topics] and
                (amount is None or str(log.get("data", "")).lower() == f"0x{amount:064x}")):
            return True
    return False


def _topic_address(address):
    return "0x" + "0" * 24 + address.lower().removeprefix("0x")


@ROUTER.get("/verify")
async def verify_route():
    if not _enabled():
        return JSONResponse({"ok": False, "error": "Mainnet verification is available on the mainnet site"}, status_code=404)
    try:
        proof, manifest, transactions = _record()
        async with httpx.AsyncClient(timeout=httpx.Timeout(10, connect=3), trust_env=False) as client:
            chain = await _rpc_call(client, "eth_chainId", [], 1)
            if int(chain, 16) != 196:
                raise ValueError("Mainnet RPC returned the wrong chain")
            steps = ("fund-job", "submit-delivery", "complete-job")
            receipts = await asyncio.gather(*[
                _rpc_call(client, "eth_getTransactionReceipt", [transactions[step]["hash"]], index + 2)
                for index, step in enumerate(steps)
            ])
        escrow = manifest["escrow"]
        for step, receipt in zip(steps, receipts):
            if (not receipt or int(receipt.get("status", "0x0"), 16) != 1 or
                    str(receipt.get("to", "")).lower() != escrow.lower() or
                    str(receipt.get("transactionHash", "")).lower() != transactions[step]["hash"].lower() or
                    int(receipt.get("blockNumber", "0x0"), 16) != transactions[step]["blockNumber"]):
                raise ValueError(f"Mainnet {step} receipt does not match the published proof")
        job = f"0x{int(proof['jobId']):064x}"
        amount = int(proof["amountRaw"])
        if not _event(receipts[0], escrow, FUNDED, [job, _topic_address(proof["roles"]["buyer"])], amount):
            raise ValueError("Mainnet funding event does not match the published proof")
        if not _event(receipts[1], escrow, DELIVERY_URI, [job, proof["delivery"]["digest"].lower()]):
            raise ValueError("Mainnet delivery event does not match the published proof")
        if (not _event(receipts[2], escrow, RELEASED,
                       [job, _topic_address(proof["roles"]["provider"])], amount) or
                not _event(receipts[2], escrow, COMPLETED,
                           [job, _topic_address(proof["roles"]["facilitator"])])):
            raise ValueError("Mainnet settlement events do not match the published proof")
        return JSONResponse({"ok": True, "verified": True, "chainId": 196,
                             "checkedAt": datetime.now(timezone.utc).isoformat(),
                             "receiptBlocks": {step: transactions[step]["blockNumber"] for step in steps}},
                            headers={"Cache-Control": "no-store"})
    except (OSError, httpx.HTTPError) as exc:
        return JSONResponse({"ok": False, "verified": False, "error": f"Mainnet RPC unavailable: {str(exc)[:140]}"},
                            status_code=503)
    except (ValueError, KeyError, TypeError) as exc:
        return JSONResponse({"ok": False, "verified": False, "error": str(exc)[:200]}, status_code=409)
