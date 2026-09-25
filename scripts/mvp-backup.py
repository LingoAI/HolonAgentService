#!/usr/bin/env python3
"""Create or restore a consistent MVP SQLite + public-content backup."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def safe_target(value):
    target = Path(value).resolve()
    if target == Path(target.anchor) or len(target.parts) < 3:
        raise ValueError("refusing a broad backup or restore target")
    return target


def storage_key(value):
    """Mirror IPFSStorage.persist_raw's path-safe key mapping."""
    return re.sub(r"[^a-zA-Z0-9_-]", "_", str(value))


def remap_delivery_paths(destination):
    """Replace machine-local delivery paths with paths inside this restore."""
    database = destination / "market.sqlite3"
    db = sqlite3.connect(database)
    try:
        exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='deliveries'"
        ).fetchone()
        if not exists:
            return
        rows = db.execute(
            "SELECT order_id, manifest_path, car_path FROM deliveries"
        ).fetchall()
        for order_id, old_manifest_path, old_car_path in rows:
            key = storage_key(order_id)
            raw_dir = destination / "ipfs" / "raw" / key
            document_path = raw_dir / "document.md"
            if not document_path.is_file():
                raise ValueError(f"restored delivery document is missing: {order_id}")
            manifest_path = raw_dir / "manifest.json" if old_manifest_path else None
            if manifest_path is not None and not manifest_path.is_file():
                raise ValueError(f"restored delivery manifest is missing: {order_id}")
            car_path = None
            if old_car_path:
                candidates = sorted((destination / "ipfs" / "car").glob(f"{key}-*.car"))
                if len(candidates) != 1:
                    raise ValueError(f"expected exactly one restored delivery CAR: {order_id}")
                car_path = candidates[0]
            db.execute(
                "UPDATE deliveries SET document_path=?, manifest_path=?, car_path=? WHERE order_id=?",
                (str(document_path), str(manifest_path) if manifest_path else None,
                 str(car_path) if car_path else None, order_id),
            )
        db.commit()
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("restored SQLite database failed integrity_check after path remap")
    finally:
        db.close()


def create(source, destination):
    source, destination = Path(source).resolve(), safe_target(destination)
    database = source / "market.sqlite3"
    if not database.is_file():
        raise ValueError(f"MVP database not found: {database}")
    destination.mkdir(parents=True, exist_ok=False)
    backup_db = destination / "market.sqlite3"
    live, backup = sqlite3.connect(database), sqlite3.connect(backup_db)
    try:
        live.backup(backup)
        if backup.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("SQLite backup failed integrity_check")
    finally:
        backup.close()
        live.close()
    for name in ("ipfs/raw", "ipfs/car"):
        item = source / name
        if item.exists():
            shutil.copytree(item, destination / name)
    files = sorted(path for path in destination.rglob("*") if path.is_file())
    manifest = {"schemaVersion": 1, "createdAt": int(time.time()), "source": str(source),
                "files": [{"path": str(path.relative_to(destination)), "size": path.stat().st_size,
                           "sha256": digest(path)} for path in files]}
    (destination / "backup-manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def restore(source, destination):
    source, destination = Path(source).resolve(), safe_target(destination)
    manifest_file = source / "backup-manifest.json"
    manifest = json.loads(manifest_file.read_text())
    for item in manifest["files"]:
        path = source / item["path"]
        if not path.is_file() or path.stat().st_size != item["size"] or digest(path) != item["sha256"]:
            raise ValueError(f"backup verification failed: {item['path']}")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("restore target must be absent or empty")
    destination.mkdir(parents=True, exist_ok=True)
    backup, target = sqlite3.connect(source / "market.sqlite3"), sqlite3.connect(destination / "market.sqlite3")
    try:
        backup.backup(target)
        if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("restored SQLite database failed integrity_check")
    finally:
        target.close()
        backup.close()
    for name in ("ipfs/raw", "ipfs/car"):
        item = source / name
        if item.exists():
            shutil.copytree(item, destination / name)
    remap_delivery_paths(destination)
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("create", "restore"))
    parser.add_argument("source")
    parser.add_argument("destination")
    args = parser.parse_args()
    result = create(args.source, args.destination) if args.operation == "create" else restore(args.source, args.destination)
    print(json.dumps({"ok": True, "operation": args.operation, "files": len(result["files"])}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
