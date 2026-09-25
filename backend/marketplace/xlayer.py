"""X Layer API boundary. Wallet transactions stay in the browser; Node owns protocol SDKs."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware

ROOT = Path(__file__).resolve().parents[2]
NETWORKS = json.loads((ROOT / "config/networks.json").read_text())
router = APIRouter()


def configuration():
    name = os.getenv("HIRE_NETWORK", "xlayer-testnet")
    if name not in NETWORKS:
        raise ValueError(f"Unknown network: {name}")
    net = dict(NETWORKS[name], name=name)
    # Wallet RPC must be public; private authenticated RPC overrides stay server-side.
    manifest_name = os.getenv("MVP_DEPLOYMENT_MANIFEST", f"{name}.json")
    if Path(manifest_name).name != manifest_name or not manifest_name.endswith(".json"):
        raise ValueError("Invalid deployment manifest name")
    deployment_file = ROOT / "contracts/deployments" / manifest_name
    deployment = json.loads(deployment_file.read_text()) if deployment_file.exists() else None
    if deployment and (deployment.get("network") != name or deployment.get("chainId") != net["chainId"]):
        raise ValueError("Deployment network mismatch")
    return {"ok": True, "network": net, "local": name == "local", "deployment": deployment,
            "configured": deployment is not None, "application": "xlayer",
            "readonly": os.getenv("HOLON_READONLY", "") in ("1", "true", "yes")}


def _connection():
    token_file = ROOT / "data/protocol-token"
    if not token_file.exists():
        raise ValueError("Protocol service is not running. Start npm run protocol.")
    port = int(os.getenv("PROTOCOL_PORT", "9402"))
    return f"http://127.0.0.1:{port}", {"X-Protocol-Token": token_file.read_text().strip()}


async def proxy(path, request=None, method="GET"):
    try:
        base, headers = _connection()
        content = None
        if request:
            content = await request.body()
            if len(content) > 32768:
                return JSONResponse({"error": "Request exceeds 32 KiB"}, status_code=413)
            headers["Content-Type"] = "application/json"
            if request.headers.get("payment-signature"):
                headers["PAYMENT-SIGNATURE"] = request.headers["payment-signature"]
        async with httpx.AsyncClient(timeout=httpx.Timeout(125, connect=3), trust_env=False) as client:
            r = await client.request(method, base + path, content=content, headers=headers)
        forwarded = {k: v for k, v in r.headers.items() if k.lower() in ("payment-required", "payment-response")}
        return Response(r.content, status_code=r.status_code, media_type="application/json", headers=forwarded)
    except (httpx.HTTPError, OSError, ValueError) as exc:
        return JSONResponse({"ok": False, "error": str(exc)[:200], "available": False}, status_code=503)


async def protocol_json(path, payload=None, method="POST", timeout=125):
    """Private FastAPI→Node call used by the MVP for ethers/RPC operations."""
    base, headers = _connection()
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=3), trust_env=False) as client:
        response = await client.request(method, base + path, json=payload or {}, headers=headers)
    try:
        body = response.json()
    except ValueError as exc:
        raise ValueError("Protocol service returned invalid JSON") from exc
    if response.status_code >= 400 or not body.get("ok", False):
        raise ValueError(str(body.get("error") or f"Protocol request failed ({response.status_code})")[:250])
    return body


def snapshot():
    base, headers = _connection()
    with httpx.Client(timeout=20, trust_env=False) as client:
        r = client.get(base + "/state", headers=headers)
        r.raise_for_status()
        return r.json()


def catalog():
    try:
        state = snapshot()
        net = configuration()["network"]
        rows = [{**a, "network": net["name"], "kind": "agent", "category": "data",
                 "categories": ["data"], "source": "lingoai-" + net["name"],
                 "provider_address": a["owner"], "serviceType": a["serviceTypes"][0] if a["serviceTypes"] else None,
                 "price": state["paymentRequirements"]["amount"],
                 "priceDecimals": state["deployment"]["token"]["decimals"]} for a in state["agents"]]
        return {"agents": rows, "network": net["name"], "ok": True}
    except (httpx.HTTPError, OSError, ValueError) as exc:
        return {"agents": [], "ok": False, "error": str(exc)[:200]}


class XLayerBoundary(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        # Keep the standalone personal twin usable on this machine. Its routes
        # do not participate in the X Layer marketplace or public deployment.
        personal_local = (os.getenv("HOLON_PERSONAL_MODE") == "1" and
                          os.getenv("HIRE_NETWORK") == "local" and
                          request.client and request.client.host in ("127.0.0.1", "::1", "testclient"))
        if personal_local and not path.startswith(("/api/market/", "/api/agents/", "/agents/", "/a2a", "/api/xlayer/")) and path not in ("/.well-known/agent-card.json", "/api/agent/research"):
            return await call_next(request)
        # The old marketplace belongs to a separate project. None of its
        # network-specific records are exposed by the OKX deployment.
        legacy = ("/api/market/", "/api/metalife/", "/api/agents/", "/agents/", "/a2a", "/.well-known/agent-card.json")
        if path.startswith(legacy):
            return JSONResponse({"error": "Use the X Layer marketplace actions for this deployment"}, status_code=409)
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and not (path.startswith(("/api/xlayer/", "/api/auth/")) or path == "/api/agent/research"):
            return JSONResponse({"error": "Legacy mutations are disabled in the X Layer marketplace"}, status_code=409)
        if request.method == "POST" and (path.startswith("/api/xlayer/") or path == "/api/agent/research"):
            origin = request.headers.get("origin")
            if origin and urlsplit(origin).netloc != request.url.netloc:
                return JSONResponse({"error": "Cross-origin mutation refused"}, status_code=403)
            if not request.headers.get("content-type", "").lower().startswith("application/json"):
                return JSONResponse({"error": "application/json required"}, status_code=415)
            if path.startswith("/api/xlayer/local-"):
                if os.getenv("HIRE_NETWORK") != "local" or not request.client or request.client.host not in ("127.0.0.1", "::1", "testclient") or request.url.hostname not in ("localhost", "127.0.0.1", "::1", "testserver"):
                    return JSONResponse({"error": "Local test actions are only available on this machine"}, status_code=403)
            if os.getenv("HOLON_READONLY", "") in ("1", "true", "yes") and (path.startswith("/api/xlayer/local-") or path in ("/api/xlayer/execute-job", "/api/agent/research")):
                return JSONResponse({"error": "Read-only deployment"}, status_code=403)
            if path == "/api/xlayer/execute-job" and os.getenv("HIRE_NETWORK") != "local":
                return JSONResponse({"error": "Platform provider signing is disabled on public networks"}, status_code=409)
        return await call_next(request)


@router.get("/api/xlayer/config")
def config_route():
    try:
        return configuration()
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=503)


@router.get("/api/xlayer/state")
async def state_route():
    return await proxy("/state")


@router.post("/api/xlayer/prepare")
async def prepare_route(request: Request):
    return await proxy("/prepare", request, "POST")


@router.post("/api/xlayer/local-action")
async def local_action_route(request: Request):
    return await proxy("/local-action", request, "POST")


@router.post("/api/xlayer/execute-job")
async def execute_route(request: Request):
    return await proxy("/execute-job", request, "POST")


@router.post("/api/xlayer/local-buyer")
async def buyer_route(request: Request):
    return await proxy("/local-buyer", request, "POST")


@router.post("/api/agent/research")
async def paid_service(request: Request):
    return await proxy("/service", request, "POST")


@router.get("/api/xlayer/jobs/{job_id}/result")
def job_result(job_id: int):
    try:
        conf = configuration()
        d = conf["deployment"]
        if not d or job_id < 1:
            raise ValueError("Unknown job")
        file = ROOT / "data/xlayer" / conf["network"]["name"] / d["escrow"].lower() / d.get("deploymentId", "legacy") / f"job-{job_id}.json"
        content = json.loads(file.read_text())["content"]
        return Response(content, media_type="application/json")
    except (OSError, ValueError, KeyError):
        return JSONResponse({"error": "No submitted result for this job"}, status_code=404)
