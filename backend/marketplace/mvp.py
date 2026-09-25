"""Fixed-bounty marketplace API for X Layer testnet and the capped mainnet canary.

All mutations are authorized by the persistent X Layer SIWE session.  This
module never holds a user key: it prepares calldata through the local Node
protocol service and records transaction intent/recovery metadata only.
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .. import config
from . import xlayer, xlayer_auth
from .mvp_storage import IPFSStorage, MANIFEST_MAX, REQUEST_MAX, StorageError, canonical_json, validate_markdown
from .mvp_store import MVPStore, json_text, now_s, uid

router = APIRouter(prefix="/api/xlayer/mvp")
TEMPLATE_ID = "community-introduction-faq-v1"
RETENTION_UNTIL = "2026-10-31"
HEX_32 = re.compile(r"^0x[0-9a-fA-F]{64}$")
TX_HASH = HEX_32
DECIMAL = re.compile(r"^(0|[1-9][0-9]*)$")
AGENT_ID = re.compile(r"^(0|[1-9][0-9]{0,77})$")
MAX_AMOUNT_RAW = 1_000_000 * 10**6
MAINNET_USDC = "0xb6ceceab302e2e4948951ee7843fc24e92933061"
_store_cache = {}
_storage_cache = {}


def _paths():
    root = Path(os.getenv("MVP_DATA_DIR") or (config.DATA_DIR / "mvp"))
    return root, root / "market.sqlite3"


def store():
    _, path = _paths()
    key = str(path.resolve())
    if key not in _store_cache:
        _store_cache[key] = MVPStore(path)
    return _store_cache[key]


def storage():
    root, _ = _paths()
    key = str(root.resolve())
    signature = (os.getenv("MVP_IPFS_API", ""), os.getenv("MVP_IPFS_API_TOKEN", ""), os.getenv("MVP_IPFS_GATEWAYS", ""))
    current = _storage_cache.get(key)
    if not current or current[0] != signature:
        current = (signature, IPFSStorage(root / "ipfs"))
        _storage_cache[key] = current
    return current[1]


def deployment():
    conf = xlayer.configuration()
    d = conf.get("deployment")
    if not d:
        raise ValueError("MVP contracts are not configured")
    token = d.get("token") or {}
    network_name, chain_id = conf["network"]["name"], conf["network"]["chainId"]
    if network_name in ("xlayer-testnet", "local") and chain_id in (1952, 31337):
        if token.get("symbol") != "dUSD" or token.get("decimals") != 6 or token.get("testToken") is not True:
            raise ValueError("MVP requires the test-only 6-decimal DemoUSD deployment")
        if chain_id == 1952 and d.get("mvpVersion") != 1:
            raise ValueError("selected testnet escrow does not support the MVP DeliveryURI contract; deploy and select the MVP manifest")
    elif network_name == "xlayer-mainnet" and chain_id == 196:
        if os.getenv("MVP_MAINNET_CANARY") != "1":
            raise ValueError("X Layer mainnet writes require the explicit capped canary profile")
        limits = d.get("limits") or {}
        if (d.get("deploymentMode") != "mainnet-canary" or d.get("canaryVersion") != 2 or
                d.get("escrowArtifact") != "MainnetCanaryEscrow"):
            raise ValueError("selected mainnet deployment is not the reviewed canary contract")
        if (str(token.get("address", "")).lower() != MAINNET_USDC or token.get("symbol") != "USDC" or
                token.get("decimals") != 6 or token.get("version") != "2" or token.get("testToken") is not False):
            raise ValueError("mainnet canary requires the reviewed X Layer USDC profile")
        if limits.get("maxBudgetRaw") != "1000000" or limits.get("maxTotalEscrowRaw") != "5000000":
            raise ValueError("mainnet canary limits must be 1 USDC per job and 5 USDC aggregate")
    else:
        raise ValueError("MVP writes are restricted to X Layer testnet, local development, or the explicit mainnet canary")
    return conf, d


async def body(request):
    length = request.headers.get("content-length")
    if length and int(length) > REQUEST_MAX:
        raise ValueError("request exceeds 128 KiB")
    raw = await request.body()
    if len(raw) > REQUEST_MAX:
        raise ValueError("request exceeds 128 KiB")
    try:
        value = json.loads(raw or b"{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("request body must be valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("request body must be a JSON object")
    return value


def error(exc, status=400):
    return JSONResponse({"ok": False, "error": str(exc)[:300]}, status_code=status)


def user(request, required=True):
    address = xlayer_auth.current_user(store(), request)
    if required and not address:
        raise PermissionError("sign in with the connected wallet first")
    if required and request.method not in ("GET", "HEAD", "OPTIONS"):
        conf, _ = deployment()
        xlayer_auth.ensure_request_origin(request, xlayer_auth.trusted_origin(conf["network"]["name"]))
    return address


def address(value, label="address"):
    result = xlayer_auth.normalize_address(value)
    if not result:
        raise ValueError(f"{label} must be a 0x EOA address")
    return result


def amount_raw(value, deployment_record=None):
    text = str(value or "")
    token = (deployment_record or {}).get("token") or {}
    maximum = int(((deployment_record or {}).get("limits") or {}).get("maxBudgetRaw") or MAX_AMOUNT_RAW)
    symbol = token.get("symbol") or "dUSD"
    if not DECIMAL.fullmatch(text) or not 0 < int(text) <= maximum:
        raise ValueError(f"amountRaw must be a positive {symbol} base-unit integer at or below {maximum}")
    return text


def agent_id(value):
    text = str(value if value is not None else "")
    if not AGENT_ID.fullmatch(text):
        raise ValueError("agentId must be a non-negative integer")
    return text


def text(value, label, maximum, minimum=1):
    result = str(value or "").strip()
    size = len(result.encode("utf-8"))
    if size < minimum or size > maximum:
        raise ValueError(f"{label} must contain {minimum}–{maximum} UTF-8 bytes")
    return result


def string_list(value, label, *, maximum_items, item_bytes):
    if not isinstance(value, list) or not value or len(value) > maximum_items:
        raise ValueError(f"{label} must contain 1–{maximum_items} items")
    return [text(item, label, item_bytes) for item in value]


def source_list(value):
    rows = string_list(value, "sources", maximum_items=12, item_bytes=500)
    for item in rows:
        parsed = urlsplit(item)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("sources must be public HTTP(S) URLs")
        try:
            ip = ipaddress.ip_address(parsed.hostname)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                raise ValueError("sources cannot use private or local addresses")
        except ValueError as exc:
            if "private or local" in str(exc):
                raise
    return rows


def public_task(row):
    if not row:
        return None
    result = dict(row)
    for source, target in (("facts_json", "facts"), ("sources_json", "sources"), ("acceptance_json", "acceptance")):
        result[target] = json.loads(result.pop(source))
    return result


def public_application(row):
    if not row:
        return None
    result = dict(row)
    result["typedData"] = json.loads(result.pop("typed_data_json"))
    return result


def _task_manifest(task):
    return {
        "schemaVersion": "1.0",
        "kind": "lingoai.mainnet-usdc-task" if task["chain_id"] == 196 else "lingoai.demo-usd-task",
        "chainId": task["chain_id"],
        "escrow": task["escrow"],
        "taskUid": task["uid"],
        "templateId": TEMPLATE_ID,
        "buyer": task["buyer"],
        "title": task["title"],
        "communityIntroduction": task["community_intro"],
        "confirmedFacts": json.loads(task["facts_json"]),
        "publicSources": json.loads(task["sources_json"]),
        "targetAudience": task["audience"],
        "acceptanceChecklist": json.loads(task["acceptance_json"]),
        "amountRaw": task["amount_raw"],
        "evaluator": task["evaluator"],
        "expiredAt": task["expired_at"],
        "publicContent": True,
        "expiryRule": "Funded or Submitted orders can be refunded to the buyer at or after expiredAt, including delivered but unreviewed work.",
    }


async def keccak(raw):
    result = await xlayer.protocol_json("/keccak", {"bytesBase64": base64.b64encode(raw).decode()})
    return result["keccak256"]


async def chain_owner(value):
    result = await xlayer.protocol_json("/registry-owner", {"agentId": agent_id(value)})
    return address(result["owner"], "registry owner")


async def chain_agent(value):
    result = await xlayer.protocol_json("/registry-owner", {"agentId": agent_id(value)})
    return {"owner": address(result["owner"], "registry owner"),
            "metadata_uri": text(result.get("metadataURI"), "on-chain metadata URI", 2048)}


async def verified_provider(conf, d, provider_address, value):
    value = agent_id(value)
    profile = store().provider(conf["network"]["chainId"], d["identityRegistry"].lower(), value)
    if not profile or not profile["active"]:
        raise ValueError("provider profile is not registered in this marketplace")
    current = await chain_agent(value)
    owner = current["owner"]
    if owner != provider_address or profile["owner"] != owner or profile["metadata_uri"] != current["metadata_uri"]:
        raise ValueError("the chain owner or metadata URI of this Agent identity has changed")
    return profile


def typed_application(d, task, provider, value_agent_id, application_nonce, valid_until):
    app_domain = d.get("applicationDomain") or {"name": "LingoAI DemoUSD Market", "version": "1"}
    return {
        "domain": {"name": app_domain["name"], "version": app_domain["version"], "chainId": task["chain_id"],
                   "verifyingContract": d["escrow"]},
        "types": {"Application": [
            {"name": "taskUid", "type": "string"}, {"name": "taskHash", "type": "bytes32"},
            {"name": "provider", "type": "address"}, {"name": "agentId", "type": "uint256"},
            {"name": "amountRaw", "type": "uint256"}, {"name": "evaluator", "type": "address"},
            {"name": "expiredAt", "type": "uint256"}, {"name": "applicationNonce", "type": "bytes32"},
            {"name": "validUntil", "type": "uint256"},
        ]},
        "primaryType": "Application",
        "message": {"taskUid": task["uid"], "taskHash": task["task_hash"], "provider": provider,
                    "agentId": str(value_agent_id), "amountRaw": task["amount_raw"], "evaluator": task["evaluator"],
                    "expiredAt": str(task["expired_at"]), "applicationNonce": application_nonce,
                    "validUntil": str(valid_until)},
    }


@router.get("/config")
def mvp_config():
    try:
        conf, d = deployment()
        try:
            origin = xlayer_auth.trusted_origin(conf["network"]["name"])
            auth_ready, auth_error = True, None
        except ValueError as exc:
            origin, auth_ready, auth_error = None, False, str(exc)
        token = d.get("token") or {}
        return {"ok": True, "schemaVersion": 1, "templateId": TEMPLATE_ID,
                "retentionUntil": os.getenv("MVP_RETENTION_UNTIL", RETENTION_UNTIL),
                "network": conf["network"], "deployment": d, "auth": {"ready": auth_ready, "origin": origin, "error": auth_error},
                "storage": {"ready": storage().configured, "gateways": storage().gateways},
                "rules": {"publicContent": True, "absoluteDeadline": True, "submittedMayExpireToBuyer": True,
                          "contractWalletsSupported": False, "testToken": token.get("testToken") is True,
                          "mainnetCanary": d.get("deploymentMode") == "mainnet-canary",
                          "maxBudgetRaw": ((d.get("limits") or {}).get("maxBudgetRaw") or str(MAX_AMOUNT_RAW))}}
    except (ValueError, OSError) as exc:
        return error(exc, 503)


@router.post("/auth/challenge")
async def auth_challenge(request: Request):
    try:
        payload = await body(request)
        conf, _ = deployment()
        origin = xlayer_auth.trusted_origin(conf["network"]["name"])
        xlayer_auth.ensure_request_origin(request, origin)
        requester = f"{request.client.host if request.client else 'unknown'}:{str(payload.get('address','')).lower()}"
        return {"ok": True, **xlayer_auth.issue(store(), address=payload.get("address"), requester_key=requester,
                                                origin=origin, chain_id=conf["network"]["chainId"])}
    except (ValueError, OSError) as exc:
        return error(exc, 429 if "too many" in str(exc) else 400)


@router.post("/auth/verify")
async def auth_verify(request: Request):
    try:
        payload = await body(request)

        async def recover(message, signature):
            result = await xlayer.protocol_json("/verify-message", {"message": message, "signature": signature})
            return result["address"]

        wallet, token = await xlayer_auth.verify(store(), nonce=payload.get("nonce"), signature=payload.get("signature"), recover=recover)
        response = JSONResponse({"ok": True, "address": wallet})
        response.set_cookie(xlayer_auth.COOKIE, token, max_age=xlayer_auth.SESSION_TTL_S, httponly=True,
                            secure=(request.headers.get("x-forwarded-proto") or request.url.scheme) == "https",
                            samesite="strict", path="/api/xlayer/mvp")
        return response
    except (ValueError, httpx.HTTPError, OSError) as exc:
        return error(exc, 401)


@router.post("/auth/logout")
def auth_logout(request: Request):
    xlayer_auth.logout(store(), request)
    response = JSONResponse({"ok": True})
    response.delete_cookie(xlayer_auth.COOKIE, path="/api/xlayer/mvp")
    return response


@router.get("/auth/session")
def auth_session(request: Request):
    return {"ok": True, "address": user(request, required=False)}


@router.post("/providers/metadata")
async def provider_metadata(request: Request):
    try:
        owner = user(request)
        payload = await body(request)
        profile = {"schemaVersion": "1.0", "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
                   "name": text(payload.get("name"), "name", 80),
                   "description": text(payload.get("introduction"), "introduction", 1200),
                   "owner": owner, "active": True, "templates": [TEMPLATE_ID], "services": []}
        raw = canonical_json(profile)
        path = storage().persist_raw(f"provider-{owner}", "metadata.json", raw)
        cid = await run_in_threadpool(storage().pin_bytes, "metadata.json", raw)
        return {"ok": True, "metadataURI": f"ipfs://{cid}", "cid": cid, "sha256": hashlib.sha256(raw).hexdigest(),
                "localPath": str(path)}
    except PermissionError as exc:
        return error(exc, 401)
    except (ValueError, StorageError, OSError) as exc:
        return error(exc, 503 if isinstance(exc, StorageError) else 400)


@router.post("/providers")
async def save_provider(request: Request):
    try:
        owner = user(request)
        payload = await body(request)
        conf, d = deployment()
        value_agent_id = agent_id(payload.get("agentId"))
        current = await chain_agent(value_agent_id)
        if current["owner"] != owner:
            raise PermissionError("connected wallet does not own this Agent identity")
        metadata_uri = text(payload.get("metadataURI"), "metadataURI", 2048)
        if not re.fullmatch(r"ipfs://b[a-z2-7]+|https://[^\s]+", metadata_uri):
            raise ValueError("metadataURI must be a public HTTPS or CIDv1 IPFS URI")
        if metadata_uri != current["metadata_uri"]:
            raise ValueError("metadataURI does not match the Agent identity's current on-chain URI")
        record = {"chain_id": conf["network"]["chainId"], "registry": d["identityRegistry"].lower(),
                  "agent_id": value_agent_id, "owner": owner, "name": text(payload.get("name"), "name", 80),
                  "introduction": text(payload.get("introduction"), "introduction", 1200), "template_id": TEMPLATE_ID,
                  "metadata_uri": metadata_uri, "registration_tx_hash": payload.get("registrationTxHash")}
        if record["registration_tx_hash"] and not TX_HASH.fullmatch(str(record["registration_tx_hash"])):
            raise ValueError("invalid registration transaction hash")
        store().upsert_provider(record)
        return {"ok": True, "provider": store().provider(record["chain_id"], record["registry"], value_agent_id)}
    except PermissionError as exc:
        return error(exc, 403)
    except (ValueError, httpx.HTTPError, OSError) as exc:
        return error(exc, 400)


@router.get("/providers")
def providers():
    try:
        conf, d = deployment()
        return {"ok": True, "providers": store().list_providers(conf["network"]["chainId"], d["identityRegistry"].lower())}
    except (ValueError, OSError) as exc:
        return error(exc, 503)


@router.get("/chain")
async def sync_chain():
    try:
        conf, d = deployment()
        state = await xlayer.protocol_json("/state", {}, method="GET", timeout=25)
        if str(state.get("deployment", {}).get("escrow", "")).lower() != d["escrow"].lower():
            raise ValueError("protocol and API selected different escrow deployments")
        store().apply_chain_snapshot(chain_id=conf["network"]["chainId"], escrow=d["escrow"],
                                     events=state.get("transactions", []), jobs=state.get("jobs", []),
                                     block_number=state["blockNumber"], anchor_number=state.get("anchorNumber"),
                                     anchor_hash=state.get("anchorHash"))
        return {"ok": True, "blockNumber": state["blockNumber"],
                "events": store().chain_event_count(conf["network"]["chainId"], d["escrow"]),
                "legacyJobs": state.get("legacyJobs", [])}
    except (ValueError, httpx.HTTPError, OSError) as exc:
        return error(exc, 503)


@router.post("/tasks")
async def create_task(request: Request):
    try:
        buyer = user(request)
        payload = await body(request)
        conf, d = deployment()
        expires = int(payload.get("expiredAt") or (now_s() + 24 * 3600))
        if expires < now_s() + 3600 or expires > now_s() + 7 * 24 * 3600:
            raise ValueError("deadline must be between 1 hour and 7 days from now; the default is 24 hours")
        task = {"uid": uid("task"), "chain_id": conf["network"]["chainId"], "escrow": d["escrow"].lower(),
                "buyer": buyer, "title": text(payload.get("title"), "title", 120),
                "community_intro": text(payload.get("communityIntroduction"), "communityIntroduction", 4000),
                "facts_json": json_text(string_list(payload.get("confirmedFacts"), "confirmedFacts", maximum_items=20, item_bytes=500)),
                "sources_json": json_text(source_list(payload.get("publicSources"))),
                "audience": text(payload.get("targetAudience"), "targetAudience", 500),
                "acceptance_json": json_text(string_list(payload.get("acceptanceChecklist"), "acceptanceChecklist", maximum_items=20, item_bytes=500)),
                "template_id": TEMPLATE_ID, "amount_raw": amount_raw(payload.get("amountRaw"), d),
                "evaluator": address(payload.get("evaluator"), "evaluator"), "expired_at": expires,
                "task_hash": "", "manifest_cid": "", "manifest_sha256": "", "status": "open",
                "selected_application_id": None, "created_at": now_s(), "closed_at": None}
        raw = canonical_json(_task_manifest(task))
        storage().persist_raw(task["uid"], "task.json", raw)
        task["task_hash"] = await keccak(raw)
        task["manifest_sha256"] = hashlib.sha256(raw).hexdigest()
        task["manifest_cid"] = await run_in_threadpool(storage().pin_bytes, "task.json", raw)
        store().create_task(task)
        return {"ok": True, "task": public_task(task)}
    except PermissionError as exc:
        return error(exc, 401)
    except (ValueError, StorageError, httpx.HTTPError, OSError) as exc:
        return error(exc, 503 if isinstance(exc, (StorageError, httpx.HTTPError, OSError)) else 400)


@router.get("/tasks")
def tasks(request: Request, mine: int = 0):
    me = user(request, required=False)
    if mine and not me:
        return error(PermissionError("sign in first"), 401)
    return {"ok": True, "tasks": [public_task(row) for row in store().list_tasks(address=me if mine else None)], "me": me}


@router.get("/tasks/{task_uid}")
def get_task(task_uid: str):
    task = store().task(task_uid)
    if not task:
        return error(ValueError("task not found"), 404)
    return {"ok": True, "task": public_task(task),
            "applications": [public_application(row) for row in store().list_applications(task_uid)]}


@router.post("/tasks/{task_uid}/close")
def close_task(task_uid: str, request: Request):
    try:
        if not store().close_task(task_uid, user(request)):
            raise ValueError("task is not open or is not owned by this wallet")
        return {"ok": True}
    except PermissionError as exc:
        return error(exc, 401)
    except ValueError as exc:
        return error(exc, 409)


@router.post("/tasks/{task_uid}/application-data")
async def application_data(task_uid: str, request: Request):
    try:
        provider = user(request)
        payload = await body(request)
        conf, d = deployment()
        task = store().task(task_uid)
        if not task or task["status"] != "open" or task["expired_at"] <= now_s() + 1800:
            raise ValueError("task is not open or has too little time remaining")
        value_agent_id = agent_id(payload.get("agentId"))
        await verified_provider(conf, d, provider, value_agent_id)
        nonce = "0x" + secrets.token_hex(32)
        valid_until = min(task["expired_at"] - 60, now_s() + 3600)
        return {"ok": True, "typedData": typed_application(d, task, provider, value_agent_id, nonce, valid_until)}
    except PermissionError as exc:
        return error(exc, 401)
    except (ValueError, httpx.HTTPError, OSError) as exc:
        return error(exc, 409 if "not open" in str(exc) else 400)


@router.post("/tasks/{task_uid}/applications")
async def apply(task_uid: str, request: Request):
    try:
        provider = user(request)
        payload = await body(request)
        conf, d = deployment()
        task = store().task(task_uid)
        if not task or task["status"] != "open":
            raise ValueError("task is not open")
        value_agent_id = agent_id(payload.get("agentId"))
        await verified_provider(conf, d, provider, value_agent_id)
        nonce = str(payload.get("applicationNonce") or "")
        signature = str(payload.get("signature") or "")
        valid_until = int(payload.get("validUntil") or 0)
        if not HEX_32.fullmatch(nonce) or not re.fullmatch(r"0x[0-9a-fA-F]{130}", signature):
            raise ValueError("invalid application nonce or EIP-712 signature")
        if valid_until <= now_s() or valid_until > min(task["expired_at"], now_s() + 3600):
            raise ValueError("application signature has expired or has an invalid validity window")
        typed = typed_application(d, task, provider, value_agent_id, nonce, valid_until)
        result = await xlayer.protocol_json("/verify-typed-data", {"domain": typed["domain"], "types": typed["types"],
                                                                   "value": typed["message"], "signature": signature})
        if address(result["address"], "signer") != provider:
            raise PermissionError("application was signed by a different wallet")
        record = {"id": uid("app"), "task_uid": task_uid, "provider": provider, "agent_id": value_agent_id,
                  "amount_raw": task["amount_raw"], "evaluator": task["evaluator"], "expired_at": task["expired_at"],
                  "application_nonce": nonce.lower(), "valid_until": valid_until, "signature": signature,
                  "typed_data_json": json_text(typed), "status": "active", "created_at": now_s(), "withdrawn_at": None}
        store().create_application(record)
        return {"ok": True, "application": public_application(record)}
    except PermissionError as exc:
        return error(exc, 403)
    except (ValueError, httpx.HTTPError, OSError) as exc:
        return error(exc, 409 if "task is not open" in str(exc) else 400)


@router.post("/applications/{application_id}/withdraw")
def withdraw(application_id: str, request: Request):
    try:
        if not store().withdraw_application(application_id, user(request)):
            raise ValueError("application is not active or is not owned by this wallet")
        return {"ok": True}
    except PermissionError as exc:
        return error(exc, 401)
    except ValueError as exc:
        return error(exc, 409)


@router.post("/tasks/{task_uid}/select")
async def select(task_uid: str, request: Request):
    try:
        buyer = user(request)
        payload = await body(request)
        conf, d = deployment()
        task = store().task(task_uid)
        app = store().application(str(payload.get("applicationId") or ""))
        if not task or not app or app["task_uid"] != task_uid:
            raise ValueError("task or application not found")
        await verified_provider(conf, d, app["provider"], app["agent_id"])
        if task["expired_at"] <= now_s() + 1800:
            raise ValueError("too little time remains to fund and deliver; publish a new task")
        order = {"id": uid("order"), "task_uid": task_uid, "application_id": app["id"],
                 "chain_id": task["chain_id"], "escrow": task["escrow"], "job_id": None, "buyer": buyer,
                 "provider": app["provider"], "evaluator": task["evaluator"], "agent_id": app["agent_id"],
                 "amount_raw": task["amount_raw"], "expired_at": task["expired_at"], "create_tx_hash": None,
                 "status": "selected", "chain_status": None, "created_at": now_s(), "updated_at": now_s()}
        store().select_application(task_uid=task_uid, application_id=app["id"], buyer=buyer, order=order)
        return {"ok": True, "order": order}
    except PermissionError as exc:
        return error(exc, 403)
    except (ValueError, httpx.HTTPError, OSError) as exc:
        return error(exc, 409)


@router.get("/orders")
def orders(request: Request, mine: int = 0):
    me = user(request, required=False)
    if mine and not me:
        return error(PermissionError("sign in first"), 401)
    return {"ok": True, "orders": store().list_orders(me if mine else None), "me": me}


@router.get("/orders/{order_id}")
def get_order(order_id: str):
    order = store().order(order_id)
    if not order:
        return error(ValueError("order not found"), 404)
    return {"ok": True, "order": order, "delivery": store().delivery(order_id)}


def _role_for_action(order, actor, action):
    if action in ("create", "budget", "approve", "fund") and actor != order["buyer"]:
        raise PermissionError("only the buyer can create and fund this order")
    if action == "submit" and actor != order["provider"]:
        raise PermissionError("only the selected provider can submit this order")
    if action in ("complete",) and actor != order["evaluator"]:
        raise PermissionError("only the designated evaluator can complete this order")
    if action == "reject" and actor not in (order["buyer"], order["evaluator"]):
        raise PermissionError("wallet is not authorized to reject this order")


def _description(task, app):
    value = {"taskUid": task["uid"], "taskCid": task["manifest_cid"], "taskHash": task["task_hash"],
             "applicationId": app["id"], "applicationSha256": hashlib.sha256(app["signature"].encode()).hexdigest()}
    return json_text(value)


async def _confirmed_chain_job(order):
    state = await xlayer.protocol_json("/state", {}, method="GET", timeout=25)
    job = next((item for item in state.get("jobs", []) if item["id"] == str(order["job_id"])), None)
    if not job:
        raise ValueError("linked on-chain job is not visible yet")
    expected = {"client": order["buyer"], "provider": order["provider"], "evaluator": order["evaluator"]}
    for key, wanted in expected.items():
        if str(job.get(key, "")).lower() != wanted:
            raise ValueError(f"on-chain {key} does not match the selected order")
    if int(job["expiredAt"]) != order["expired_at"] or str(job.get("agentId")) != order["agent_id"]:
        raise ValueError("on-chain identity or deadline does not match the selected order")
    job["_blockTimestamp"] = int(state.get("blockTimestamp") or now_s())
    return job


@router.post("/intents")
async def create_intent(request: Request):
    try:
        actor = user(request)
        payload = await body(request)
        action = str(payload.get("action") or "")
        if action not in ("register", "create", "budget", "approve", "fund", "submit", "complete", "reject", "refund"):
            raise ValueError("unsupported wallet action")
        idem = str(payload.get("idempotencyKey") or "")
        if not re.fullmatch(r"[a-zA-Z0-9:_-]{8,128}", idem):
            raise ValueError("idempotencyKey must contain 8–128 safe characters")
        conf, d = deployment()
        object_id = str(payload.get("objectId") or "")
        if action == "register":
            args = {"action": "register", "account": actor,
                    "metadataURI": text(payload.get("metadataURI"), "metadataURI", 2048)}
            object_type = "provider-registration"
        else:
            order = store().order(object_id)
            if not order:
                raise ValueError("order not found")
            _role_for_action(order, actor, action)
            object_type = "order"
            args = {"action": action, "account": actor}
            if action == "create":
                task = store().task(order["task_uid"])
                app = store().application(order["application_id"])
                args.update(agentId=order["agent_id"], evaluator=order["evaluator"], expiredAt=order["expired_at"],
                            description=_description(task, app))
            else:
                if not order["job_id"]:
                    raise ValueError("order has no confirmed on-chain job yet")
                job = await _confirmed_chain_job(order)
                args["jobId"] = order["job_id"]
                required_state = {"budget": "Created", "approve": "Created", "fund": "Created",
                                  "submit": "Funded", "complete": "Submitted"}
                if action in required_state and job["status"] != required_state[action]:
                    raise ValueError(f"on-chain job must be {required_state[action]} for {action}")
                if action == "fund" and order["expired_at"] <= now_s() + 900:
                    raise ValueError("too little time remains to fund and deliver; publish a new task")
                if action == "reject":
                    expected = (order["buyer"] if job["status"] == "Created" else
                                order["evaluator"] if job["status"] in ("Funded", "Submitted") else None)
                    if actor != expected:
                        raise PermissionError("wallet is not authorized to reject the current on-chain state")
                if action == "refund" and (job["status"] not in ("Funded", "Submitted") or
                                            job["_blockTimestamp"] < order["expired_at"]):
                    raise ValueError("refund is available only after the funded/submitted order deadline")
                if action == "budget":
                    decimals = int(d["token"]["decimals"])
                    whole, fraction = divmod(int(order["amount_raw"]), 10**decimals)
                    args["amount"] = f"{whole}.{fraction:0{decimals}d}".rstrip("0").rstrip(".")
                elif action in ("approve", "fund"):
                    if action == "fund" and str(job["budgetRaw"]) != order["amount_raw"]:
                        raise ValueError("on-chain budget changed; refusing to fund")
                    args["budgetRaw"] = order["amount_raw"]
                elif action == "submit":
                    delivery = store().delivery(order["id"])
                    if not delivery or delivery["stage"] != "ready":
                        raise ValueError("delivery is not pinned, verified and backed up")
                    args.update(deliverable=delivery["manifest_keccak"], uri=delivery["uri"])
                elif action in ("complete", "reject"):
                    reason = payload.get("reason") or "0x" + "0" * 64
                    if not HEX_32.fullmatch(str(reason)):
                        raise ValueError("reason must be bytes32")
                    args["reason"] = reason
        prepared = await xlayer.protocol_json("/prepare", args)
        tx = prepared["transaction"]
        at = now_s()
        record = {"id": uid("tx"), "idempotency_key": idem, "actor": actor, "action": action,
                  "object_type": object_type, "object_id": object_id, "account": actor,
                  "chain_id": conf["network"]["chainId"], "to_address": tx["to"], "tx_data": tx["data"],
                  "tx_hash": None, "state": "prepared", "receipt_json": None, "error": None,
                  "created_at": at, "updated_at": at}
        saved = store().create_intent(record)
        return {"ok": True, "intent": saved, "transaction": {"to": saved["to_address"], "data": saved["tx_data"],
                                                                 "value": "0x0", "chainId": hex(saved["chain_id"])}}
    except PermissionError as exc:
        return error(exc, 403)
    except (ValueError, httpx.HTTPError, OSError) as exc:
        return error(exc, 409 if "refusing" in str(exc) or "not" in str(exc) else 400)


@router.post("/intents/{intent_id}/broadcast")
async def broadcast_intent(intent_id: str, request: Request):
    try:
        actor = user(request)
        payload = await body(request)
        value = str(payload.get("txHash") or "")
        if not TX_HASH.fullmatch(value):
            raise ValueError("invalid transaction hash")
        current = store().intent(intent_id)
        if not current or current["actor"] != actor:
            raise PermissionError("intent is not owned by this wallet")
        if current["tx_hash"] and current["tx_hash"] != value.lower():
            raise ValueError("intent is already bound to a different transaction hash")
        if current["state"] in ("confirmed", "failed", "mismatch"):
            return {"ok": current["state"] == "confirmed", "intent": current}
        if not store().update_intent(intent_id, actor=actor, tx_hash=value.lower(), state="broadcast"):
            raise PermissionError("intent is not owned by this wallet")
        intent = store().intent(intent_id)
        if intent["action"] == "create":
            store().update_order(intent["object_id"], create_tx_hash=value.lower(), status="creating")
        return {"ok": True, "intent": intent}
    except PermissionError as exc:
        return error(exc, 403)
    except ValueError as exc:
        return error(exc, 400)


@router.post("/intents/{intent_id}/reconcile")
async def reconcile_intent(intent_id: str, request: Request):
    try:
        actor = user(request)
        intent = store().intent(intent_id)
        if not intent or intent["actor"] != actor:
            raise PermissionError("intent is not owned by this wallet")
        if not intent["tx_hash"]:
            raise ValueError("intent has not been broadcast")
        receipt = await xlayer.protocol_json("/receipt", {"hash": intent["tx_hash"]}, timeout=25)
        if receipt.get("pending"):
            return {"ok": True, "pending": True, "intent": intent}
        state = "confirmed" if receipt.get("status") == 1 else "failed"
        failure = None
        if state == "confirmed" and (str(receipt.get("from", "")).lower() != intent["account"] or
                                     str(receipt.get("to", "")).lower() != str(intent["to_address"]).lower() or
                                     str(receipt.get("data", "")).lower() != str(intent["tx_data"]).lower() or
                                     str(receipt.get("value", "0")) != "0"):
            state, failure = "mismatch", "confirmed transaction does not match the prepared sender, target, calldata and value"
            if intent["object_type"] == "order" and intent["action"] == "create":
                store().update_order(intent["object_id"], status="creation_mismatch")
        if state == "confirmed" and intent["object_type"] == "order":
            order = store().order(intent["object_id"])
            if intent["action"] == "create":
                event = next((event for event in receipt.get("events", []) if event["name"] == "JobCreated"), None)
                linked = next((event for event in receipt.get("events", []) if event["name"] == "AgentLinked"), None)
                args = event.get("args", {}) if event else {}
                roles = {"client": order["buyer"], "provider": order["provider"], "evaluator": order["evaluator"]}
                task, application = store().task(order["task_uid"]), store().application(order["application_id"])
                if (not event or not linked or any(str(args.get(key, "")).lower() != wanted for key, wanted in roles.items())
                    or int(args.get("expiredAt", 0)) != order["expired_at"]
                    or args.get("description") != _description(task, application)
                    or str(linked.get("args", {}).get("agentId")) != order["agent_id"]
                    or str(linked.get("args", {}).get("provider", "")).lower() != order["provider"]):
                    state, failure = "mismatch", "created job does not match the frozen order"
                    store().update_order(order["id"], status="creation_mismatch")
                else:
                    store().update_order(order["id"], job_id=str(args["jobId"]), status="created", chain_status="Created")
            elif intent["action"] == "submit":
                store().update_delivery(order["id"], stage="submitted", tx_hash=intent["tx_hash"])
                store().update_order(order["id"], status="submitted", chain_status="Submitted")
            elif intent["action"] == "complete":
                store().update_order(order["id"], status="completed", chain_status="Completed")
            elif intent["action"] == "reject":
                store().update_order(order["id"], status="rejected", chain_status="Rejected")
            elif intent["action"] == "refund":
                store().update_order(order["id"], status="expired", chain_status="Expired")
            elif intent["action"] == "fund":
                store().update_order(order["id"], status="funded", chain_status="Funded")
        store().update_intent(intent_id, actor=actor, state=state, receipt_json=json_text(receipt), error=failure)
        return {"ok": state == "confirmed", "pending": False, "intent": store().intent(intent_id), "receipt": receipt,
                **({"error": failure} if failure else {})}
    except PermissionError as exc:
        return error(exc, 403)
    except (ValueError, httpx.HTTPError, OSError) as exc:
        return error(exc, 409)


@router.get("/intents")
def intents(request: Request):
    try:
        return {"ok": True, "intents": store().list_intents(user(request))}
    except PermissionError as exc:
        return error(exc, 401)


@router.post("/orders/{order_id}/delivery")
async def create_delivery(order_id: str, request: Request):
    try:
        provider = user(request)
        payload = await body(request)
        order = store().order(order_id)
        if not order or order["provider"] != provider:
            raise PermissionError("only the selected provider can upload this delivery")
        if not order["job_id"]:
            raise ValueError("order has no confirmed on-chain job")
        job = await _confirmed_chain_job(order)
        if job["status"] != "Funded":
            raise ValueError("on-chain job must be Funded before uploading a delivery")
        raw = validate_markdown(payload.get("document"))
        file_sha = hashlib.sha256(raw).hexdigest()
        existing = store().delivery(order_id)
        if existing and existing["file_sha256"] != file_sha:
            raise ValueError("a different delivery version already exists for this order")
        document_path = storage().persist_raw(order_id, "document.md", raw)
        if not existing:
            at = now_s()
            existing = store().save_delivery({"id": uid("delivery"), "order_id": order_id, "provider": provider,
                                               "document_path": str(document_path), "manifest_path": None,
                                               "file_cid": None, "manifest_cid": None, "file_size": len(raw),
                                               "file_sha256": file_sha, "manifest_sha256": None, "manifest_keccak": None,
                                               "uri": None, "stage": "uploaded", "error": None, "car_path": None,
                                               "tx_hash": None, "created_at": at, "updated_at": at})
        try:
            file_cid = existing["file_cid"] or await run_in_threadpool(storage().pin_bytes, "document.md", raw)
            store().update_delivery(order_id, file_cid=file_cid, stage="pinned_file", error=None)
            task = store().task(order["task_uid"])
            manifest = {"schemaVersion": "1.0", "chainId": order["chain_id"], "escrow": order["escrow"],
                        "jobId": order["job_id"], "taskUid": order["task_uid"], "taskHash": task["task_hash"],
                        "provider": provider, "templateId": TEMPLATE_ID, "fileCid": file_cid,
                        "fileSize": len(raw), "fileSha256": file_sha}
            manifest_raw = canonical_json(manifest)
            if len(manifest_raw) > MANIFEST_MAX:
                raise StorageError("delivery manifest exceeds 8 KiB")
            manifest_path = storage().persist_raw(order_id, "manifest.json", manifest_raw)
            manifest_cid = existing["manifest_cid"] or await run_in_threadpool(storage().pin_bytes, "manifest.json", manifest_raw)
            manifest_sha = hashlib.sha256(manifest_raw).hexdigest()
            manifest_keccak = await keccak(manifest_raw)
            car_path = existing["car_path"] or str(await run_in_threadpool(storage().export_pair, order_id, raw, manifest_raw, file_cid, manifest_cid))
            store().update_delivery(order_id, manifest_path=str(manifest_path), manifest_cid=manifest_cid,
                                    manifest_sha256=manifest_sha, manifest_keccak=manifest_keccak,
                                    uri=f"ipfs://{manifest_cid}", car_path=car_path, stage="ready", error=None)
            store().update_order(order_id, status="delivery_ready")
        except (StorageError, httpx.HTTPError, OSError, ValueError) as exc:
            store().update_delivery(order_id, error=str(exc)[:300])
            raise
        return {"ok": True, "delivery": store().delivery(order_id)}
    except PermissionError as exc:
        return error(exc, 403)
    except (ValueError, StorageError, httpx.HTTPError, OSError) as exc:
        return error(exc, 503 if isinstance(exc, (StorageError, httpx.HTTPError, OSError)) else 409)


@router.get("/orders/{order_id}/delivery")
def get_delivery(order_id: str):
    delivery = store().delivery(order_id)
    if not delivery:
        return error(ValueError("delivery not found"), 404)
    result = dict(delivery)
    if result.get("file_cid"):
        result["fileGateways"] = storage().gateway_urls(result["file_cid"])
    if result.get("manifest_cid"):
        result["manifestGateways"] = storage().gateway_urls(result["manifest_cid"])
    return {"ok": True, "delivery": result}


@router.get("/orders/{order_id}/car")
def delivery_car(order_id: str):
    delivery = store().delivery(order_id)
    if not delivery or not delivery.get("car_path") or not Path(delivery["car_path"]).is_file():
        return error(ValueError("CAR backup is unavailable"), 404)
    return FileResponse(delivery["car_path"], media_type="application/vnd.ipld.car",
                        filename=f"{order_id}-delivery.car", headers={"X-Content-Type-Options": "nosniff"})


def _indexed_content(cid):
    with store().connect() as db:
        row = db.execute("SELECT manifest_sha256 sha,'application/json' media FROM tasks WHERE manifest_cid=?", (cid,)).fetchone()
        if row:
            return dict(row)
        row = db.execute("SELECT file_sha256 sha,'text/markdown; charset=utf-8' media FROM deliveries WHERE file_cid=?", (cid,)).fetchone()
        if row:
            return dict(row)
        row = db.execute("SELECT manifest_sha256 sha,'application/json' media FROM deliveries WHERE manifest_cid=?", (cid,)).fetchone()
        return dict(row) if row else None


@router.get("/ipfs/{cid}")
async def ipfs_content(cid: str):
    try:
        record = _indexed_content(cid)
        if not record:
            return error(ValueError("CID is not indexed by this marketplace"), 404)
        raw = await run_in_threadpool(storage().read_gateway, cid, record["sha"])
        return Response(raw, media_type=record["media"], headers={"Content-Security-Policy": "default-src 'none'; sandbox",
                                                                  "X-Content-Type-Options": "nosniff"})
    except (StorageError, OSError) as exc:
        return error(exc, 502)
