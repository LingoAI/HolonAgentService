#!/usr/bin/env python3
"""Re-pin every restored MVP object into the configured Kubo service.

The SQLite backup preserves the exact raw bytes and delivery CAR files, while
Kubo's repository lives in a separate Docker volume.  A server restore is not
complete until this command has reproduced and verified every recorded CID.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.marketplace.mvp_storage import IPFSStorage, StorageError, validate_cid


def safe_key(value):
    return re.sub(r"[^a-zA-Z0-9_-]", "_", str(value))


def recorded_cid(uri):
    value = str(uri or "")
    if not value.startswith("ipfs://"):
        return None
    return validate_cid(value.removeprefix("ipfs://"))


def restore_ipfs(data_dir: Path | str, storage=None):
    data_dir = Path(data_dir).resolve()
    database = data_dir / "market.sqlite3"
    if not database.is_file():
        raise ValueError(f"MVP database not found: {database}")
    service = storage or IPFSStorage(data_dir / "ipfs")
    if not service.configured:
        raise ValueError("MVP_IPFS_API is not configured")

    pinned = set()
    imported = []

    def pin(path, expected_cid):
        expected_cid = validate_cid(expected_cid)
        path = Path(path)
        if not path.is_file():
            raise ValueError(f"restored IPFS source is missing: {path}")
        raw = path.read_bytes()
        actual = service.pin_bytes(path.name, raw)
        if actual != expected_cid:
            raise StorageError(f"restored bytes produced {actual}, expected {expected_cid}")
        pinned.add(actual)
        return raw

    db = sqlite3.connect(database)
    db.row_factory = sqlite3.Row
    try:
        for row in db.execute("SELECT owner,metadata_uri FROM providers WHERE active=1"):
            cid = recorded_cid(row["metadata_uri"])
            if cid:
                pin(data_dir / "ipfs/raw" / safe_key(f"provider-{row['owner']}") / "metadata.json", cid)

        for row in db.execute("SELECT uid,manifest_cid FROM tasks"):
            pin(data_dir / "ipfs/raw" / safe_key(row["uid"]) / "task.json", row["manifest_cid"])

        for row in db.execute(
            "SELECT order_id,document_path,manifest_path,car_path,file_cid,manifest_cid FROM deliveries"
        ):
            expected = {}
            if row["file_cid"]:
                expected[row["file_cid"]] = pin(row["document_path"], row["file_cid"])
            if row["manifest_cid"]:
                expected[row["manifest_cid"]] = pin(row["manifest_path"], row["manifest_cid"])
            if row["car_path"]:
                service.import_car(row["car_path"], expected)
                imported.append(str(Path(row["car_path"])))
    finally:
        db.close()

    return {"ok": True, "pinnedObjects": len(pinned), "importedCars": len(imported),
            "cids": sorted(pinned)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("data_dir", help="restored MVP data directory containing market.sqlite3")
    args = parser.parse_args()
    print(json.dumps(restore_ipfs(args.data_dir), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
