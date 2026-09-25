#!/usr/bin/env python3
"""Exercise real Kubo pin, exact-byte read, CAR export and optional restore."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.marketplace.mvp_storage import IPFSStorage, canonical_json, validate_markdown


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", required=True)
    parser.add_argument("--gateway", required=True)
    parser.add_argument("--restore-api")
    parser.add_argument("--root", default="data/mvp-storage-verification")
    args = parser.parse_args()
    root = Path(args.root)
    primary = IPFSStorage(root, api=args.api, gateways=args.gateway)
    document = validate_markdown("# DemoUSD Market\n\n## FAQ\n\n### Is dUSD real USD?\n\nNo. It is a test-only payment asset with no redemption promise.\n")
    primary.persist_raw("verification", "document.md", document)
    file_cid = primary.pin_bytes("document.md", document)
    manifest = {"schemaVersion": "1.0", "chainId": 1952,
                "escrow": "0xCE5613dA417360ad6B27C32Fc6bbEB93591615E8", "jobId": "verification",
                "taskUid": "storage-verification", "taskHash": "0x" + "00" * 32,
                "provider": "0x" + "11" * 20, "templateId": "community-introduction-faq-v1",
                "fileCid": file_cid, "fileSize": len(document),
                "fileSha256": hashlib.sha256(document).hexdigest()}
    manifest_raw = canonical_json(manifest)
    primary.persist_raw("verification", "manifest.json", manifest_raw)
    manifest_cid = primary.pin_bytes("manifest.json", manifest_raw)
    car = primary.export_pair("verification", document, manifest_raw, file_cid, manifest_cid)
    assert primary.read_gateway(file_cid, manifest["fileSha256"]) == document
    restored = False
    if args.restore_api:
        recovery = IPFSStorage(root / "restore", api=args.restore_api, gateways=args.gateway)
        recovery.import_car(car, {file_cid: document, manifest_cid: manifest_raw})
        restored = True
    print(json.dumps({"ok": True, "fileCid": file_cid, "manifestCid": manifest_cid,
                      "fileSha256": manifest["fileSha256"], "manifestSha256": hashlib.sha256(manifest_raw).hexdigest(),
                      "car": str(car.resolve()), "carSha256": hashlib.sha256(car.read_bytes()).hexdigest(),
                      "gatewayVerified": True, "restoredSameCids": restored}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
