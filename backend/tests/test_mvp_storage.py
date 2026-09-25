import hashlib
import json

import httpx
import pytest

from backend.marketplace.mvp_storage import IPFSStorage, StorageError, canonical_json, validate_markdown


class FakeResponse:
    def __init__(self, *, text="", content=b"", status=200):
        self.text, self.content, self.status_code = text, content, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("failed", request=None, response=None)


class FakeKubo:
    def __init__(self, objects, *, corrupt=False):
        self.objects = objects
        self.corrupt = corrupt

    def request(self, method, url, headers=None, **kwargs):
        if "/add?" in url and "wrap-with-directory=true" not in url:
            name, raw, _ = kwargs["files"]["file"]
            cid = "b" + ("a" if name.endswith(".md") else "c") * 58
            self.objects[cid] = raw
            return FakeResponse(text=json.dumps({"Name": name, "Hash": cid}))
        if "wrap-with-directory=true" in url:
            rows = []
            for _, (name, raw, _) in kwargs["files"]:
                cid = "b" + ("a" if name.endswith(".md") else "c") * 58
                self.objects[cid] = raw
                rows.append({"Name": name, "Hash": cid})
            rows.append({"Name": "", "Hash": "b" + "d" * 58})
            return FakeResponse(text="\n".join(json.dumps(row) for row in rows))
        if "/pin/ls" in url:
            return FakeResponse(text="{}")
        if "/cat" in url:
            cid = url.split("arg=")[-1]
            raw = self.objects[cid]
            return FakeResponse(content=(raw + b"tampered") if self.corrupt else raw)
        if "/dag/export" in url:
            return FakeResponse(content=b"car-bytes")
        return FakeResponse(status=404)


def test_markdown_and_canonical_manifest_are_exact_and_safe():
    assert validate_markdown("# FAQ\n\n[Site](https://example.test)").startswith(b"# FAQ")
    for unsafe in ("<script>alert(1)</script>", "![x](https://example.test/a.png)", "[x](javascript:alert(1))"):
        with pytest.raises(StorageError):
            validate_markdown(unsafe)
    assert canonical_json({"b": 1, "a": "é"}) == b'{"a":"\xc3\xa9","b":1}'


def test_pin_verifies_exact_bytes_and_car_contains_stable_child_cids(tmp_path):
    objects = {}
    service = IPFSStorage(tmp_path, api="http://kubo", client=FakeKubo(objects))
    document = b"# FAQ"
    file_cid = service.pin_bytes("document.md", document)
    manifest = canonical_json({"fileCid": file_cid, "fileSha256": hashlib.sha256(document).hexdigest()})
    manifest_cid = service.pin_bytes("manifest.json", manifest)
    car = service.export_pair("order", document, manifest, file_cid, manifest_cid)
    assert car.read_bytes() == b"car-bytes"


def test_false_gateway_or_cat_bytes_never_become_verified(tmp_path):
    service = IPFSStorage(tmp_path, api="http://kubo", client=FakeKubo({}, corrupt=True))
    with pytest.raises(StorageError, match="do not match"):
        service.pin_bytes("document.md", b"truth")


def test_content_read_prefers_verified_local_kubo_over_public_gateways(tmp_path):
    cid = "b" + "a" * 58
    raw = b"locally pinned public content"
    service = IPFSStorage(tmp_path, api="http://kubo", gateways="https://unavailable.invalid/ipfs/",
                          client=FakeKubo({cid: raw}))
    assert service.read_gateway(cid, hashlib.sha256(raw).hexdigest()) == raw


def test_content_read_rejects_corrupt_local_kubo_without_a_working_fallback(tmp_path, monkeypatch):
    cid = "b" + "a" * 58
    service = IPFSStorage(tmp_path, api="http://kubo", gateways="https://unavailable.invalid/ipfs/",
                          client=FakeKubo({cid: b"tampered"}))

    def unavailable(*args, **kwargs):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(httpx.Client, "get", unavailable)
    with pytest.raises(StorageError, match="all configured IPFS gateways failed"):
        service.read_gateway(cid, hashlib.sha256(b"expected").hexdigest())
