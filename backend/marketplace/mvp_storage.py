"""Exact-byte public document storage backed by a configured Kubo/IPFS API.

No local hash is presented as an IPFS CID.  A delivery becomes ``ready`` only
after the configured service has pinned both objects, returned their CIDv1
identifiers, served the exact bytes back, and exported a CAR containing both.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from urllib.parse import quote

import httpx

CID_V1 = re.compile(r"^b[a-z2-7]{20,190}$")
MARKDOWN_MAX = 16 * 1024
MANIFEST_MAX = 8 * 1024
REQUEST_MAX = 128 * 1024
ADD_QUERY = "cid-version=1&raw-leaves=true&hash=sha2-256&pin=true&wrap-with-directory=false"


class StorageError(RuntimeError):
    pass


def canonical_json(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def validate_cid(cid: str) -> str:
    value = str(cid or "")
    if not CID_V1.fullmatch(value):
        raise StorageError("invalid CIDv1 base32 identifier")
    return value


def validate_markdown(text: str) -> bytes:
    if not isinstance(text, str):
        raise StorageError("document must be UTF-8 Markdown text")
    raw = text.encode("utf-8")
    if not raw or len(raw) > MARKDOWN_MAX:
        raise StorageError("Markdown must contain 1–16384 UTF-8 bytes")
    if "\x00" in text:
        raise StorageError("Markdown cannot contain NUL bytes")
    # Raw HTML and automatic remote content are not accepted by the MVP.  This
    # leaves ordinary Markdown links intact; the browser preview separately
    # renders them as inert, filtered anchors.
    lowered = text.lower()
    if re.search(r"<\s*/?\s*(script|iframe|object|embed|style|link|meta|img|svg)\b", lowered):
        raise StorageError("raw executable or remote-loading HTML is not allowed")
    if re.search(r"!\[[^\]]*\]\s*\(\s*(?:https?:|//|data:|file:|javascript:)", text, re.I):
        raise StorageError("remote or executable Markdown images are not allowed")
    if re.search(r"\]\s*\(\s*(?:javascript:|data:|file:)", text, re.I):
        raise StorageError("unsafe Markdown link scheme")
    return raw


class IPFSStorage:
    def __init__(self, root: Path, *, api=None, token=None, gateways=None, client=None):
        self.root = Path(root)
        self.raw_dir = self.root / "raw"
        self.car_dir = self.root / "car"
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.car_dir.mkdir(parents=True, exist_ok=True)
        self.api = (api if api is not None else os.getenv("MVP_IPFS_API", "")).rstrip("/")
        self.token = token if token is not None else os.getenv("MVP_IPFS_API_TOKEN", "")
        raw_gateways = gateways if gateways is not None else os.getenv("MVP_IPFS_GATEWAYS", "https://ipfs.io/ipfs/")
        self.gateways = [g.rstrip("/") + "/" for g in str(raw_gateways).split(",") if g.strip()]
        self.client = client

    @property
    def configured(self):
        return bool(self.api)

    def _headers(self):
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def _request(self, method, path, **kwargs):
        if not self.api:
            raise StorageError("IPFS pin service is not configured")
        try:
            if self.client is not None:
                response = self.client.request(method, self.api + path, headers=self._headers(), **kwargs)
            else:
                with httpx.Client(timeout=httpx.Timeout(120, connect=10), trust_env=False) as client:
                    response = client.request(method, self.api + path, headers=self._headers(), **kwargs)
            response.raise_for_status()
            return response
        except (httpx.HTTPError, OSError) as exc:
            raise StorageError(f"IPFS service request failed: {str(exc)[:180]}") from exc

    def persist_raw(self, key: str, name: str, raw: bytes) -> Path:
        target_dir = self.raw_dir / re.sub(r"[^a-zA-Z0-9_-]", "_", key)
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / name
        if target.exists() and target.read_bytes() != raw:
            raise StorageError("persisted bytes differ from the requested retry")
        if not target.exists():
            temp = target.with_suffix(target.suffix + ".tmp")
            temp.write_bytes(raw)
            os.replace(temp, target)
        return target

    def pin_bytes(self, name: str, raw: bytes) -> str:
        response = self._request(
            "POST", f"/api/v0/add?{ADD_QUERY}", files={"file": (name, raw, "application/octet-stream")}
        )
        try:
            doc = json.loads(response.text.strip().splitlines()[-1])
            cid = validate_cid(doc["Hash"])
        except (KeyError, ValueError, json.JSONDecodeError, StorageError) as exc:
            raise StorageError("IPFS add did not return a valid CIDv1") from exc
        self.verify_pin(cid, raw)
        return cid

    def verify_pin(self, cid: str, expected: bytes):
        cid = validate_cid(cid)
        self._request("POST", f"/api/v0/pin/ls?arg={quote(cid)}&type=recursive")
        actual = self._request("POST", f"/api/v0/cat?arg={quote(cid)}").content
        if actual != expected:
            raise StorageError("IPFS returned bytes that do not match the uploaded object")

    def export_pair(self, key: str, file_raw: bytes, manifest_raw: bytes, file_cid: str, manifest_cid: str) -> Path:
        files = [
            ("file", ("document.md", file_raw, "text/markdown; charset=utf-8")),
            ("file", ("manifest.json", manifest_raw, "application/json")),
        ]
        response = self._request(
            "POST",
            "/api/v0/add?cid-version=1&raw-leaves=true&hash=sha2-256&pin=true&wrap-with-directory=true",
            files=files,
        )
        try:
            rows = [json.loads(line) for line in response.text.splitlines() if line.strip()]
            by_name = {row.get("Name"): row.get("Hash") for row in rows}
            root_cid = validate_cid(rows[-1]["Hash"])
            if by_name.get("document.md") != file_cid or by_name.get("manifest.json") != manifest_cid:
                raise StorageError("CAR bundle import changed a child CID")
        except (KeyError, json.JSONDecodeError, StorageError) as exc:
            raise StorageError("IPFS did not create the expected two-file directory") from exc
        car = self._request("POST", f"/api/v0/dag/export?arg={quote(root_cid)}").content
        if not car:
            raise StorageError("IPFS returned an empty CAR backup")
        target = self.car_dir / f"{re.sub(r'[^a-zA-Z0-9_-]', '_', key)}-{root_cid}.car"
        temp = target.with_suffix(".car.tmp")
        temp.write_bytes(car)
        os.replace(temp, target)
        return target

    def gateway_urls(self, cid: str):
        cid = validate_cid(cid)
        return [base + cid for base in self.gateways]

    def import_car(self, car_path: Path | str, expected):
        """Import a backup into this configured Kubo service and verify CIDs."""
        path = Path(car_path)
        raw = path.read_bytes()
        if not raw:
            raise StorageError("CAR backup is empty")
        response = self._request("POST", "/api/v0/dag/import?pin-roots=true", files={"file": (path.name, raw, "application/vnd.ipld.car")})
        try:
            rows = [json.loads(line) for line in response.text.splitlines() if line.strip()]
            roots = [validate_cid(row["Root"]["Cid"]["/"]) for row in rows if row.get("Root")]
            if not roots or any(row["Root"].get("PinErrorMsg") for row in rows if row.get("Root")):
                raise StorageError("CAR import did not pin a root")
            for root in roots:
                self._request("POST", f"/api/v0/pin/ls?arg={quote(root)}&type=recursive")
        except (KeyError, json.JSONDecodeError, StorageError) as exc:
            raise StorageError("IPFS returned an invalid CAR import result") from exc
        for cid, content in expected.items():
            actual = self._request("POST", f"/api/v0/cat?arg={quote(validate_cid(cid))}").content
            if actual != content:
                raise StorageError("restored CAR bytes do not match the expected CID content")

    def read_gateway(self, cid: str, expected_sha256: str | None = None) -> bytes:
        cid = validate_cid(cid)
        errors = []
        if self.configured:
            try:
                raw = self._request("POST", f"/api/v0/cat?arg={quote(cid)}").content
                if expected_sha256 and hashlib.sha256(raw).hexdigest() != expected_sha256:
                    raise StorageError("local Kubo bytes failed SHA-256 verification")
                return raw
            except StorageError as exc:
                errors.append("local Kubo: " + str(exc)[:100])
        for url in self.gateway_urls(cid):
            try:
                with httpx.Client(timeout=httpx.Timeout(25, connect=5), trust_env=False, follow_redirects=False) as client:
                    response = client.get(url)
                response.raise_for_status()
                raw = response.content
                if expected_sha256 and hashlib.sha256(raw).hexdigest() != expected_sha256:
                    raise StorageError("gateway bytes failed SHA-256 verification")
                return raw
            except (httpx.HTTPError, StorageError) as exc:
                errors.append(str(exc)[:100])
        raise StorageError("all configured IPFS gateways failed: " + "; ".join(errors))
