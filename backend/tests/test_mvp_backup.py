import json
import sqlite3
import subprocess
import sys
from pathlib import Path


def test_mvp_backup_uses_sqlite_backup_and_restores_exact_content(tmp_path):
    root = Path(__file__).resolve().parents[2]
    source = tmp_path / "live"
    source.mkdir()
    with sqlite3.connect(source / "market.sqlite3") as db:
        db.execute("CREATE TABLE proof(value TEXT)")
        db.execute("INSERT INTO proof VALUES('persisted')")
    (source / "ipfs/raw/order").mkdir(parents=True)
    (source / "ipfs/raw/order/document.md").write_bytes(b"# exact")
    (source / "ipfs/car").mkdir(parents=True)
    (source / "ipfs/car/order.car").write_bytes(b"car")
    backup, restored = tmp_path / "backup", tmp_path / "restored"
    command = [sys.executable, str(root / "scripts/mvp-backup.py")]
    made = subprocess.run([*command, "create", str(source), str(backup)], capture_output=True, text=True, check=True)
    assert json.loads(made.stdout)["ok"] is True
    manifest = json.loads((backup / "backup-manifest.json").read_text())
    assert {item["path"] for item in manifest["files"]} >= {"market.sqlite3", "ipfs/raw/order/document.md", "ipfs/car/order.car"}
    assert not {item["path"] for item in manifest["files"]} & {"market.sqlite3-wal", "market.sqlite3-shm"}
    subprocess.run([*command, "restore", str(backup), str(restored)], capture_output=True, text=True, check=True)
    with sqlite3.connect(restored / "market.sqlite3") as db:
        assert db.execute("SELECT value FROM proof").fetchone()[0] == "persisted"
    assert (restored / "ipfs/raw/order/document.md").read_bytes() == b"# exact"
    assert (restored / "ipfs/car/order.car").read_bytes() == b"car"


def test_mvp_restore_remaps_delivery_paths_to_the_new_data_root(tmp_path):
    root = Path(__file__).resolve().parents[2]
    source = tmp_path / "live"
    raw = source / "ipfs/raw/order_1"
    cars = source / "ipfs/car"
    raw.mkdir(parents=True)
    cars.mkdir(parents=True)
    (raw / "document.md").write_bytes(b"# delivery")
    (raw / "manifest.json").write_bytes(b'{"schemaVersion":"1.0"}')
    (cars / "order_1-bafyroot.car").write_bytes(b"car")
    with sqlite3.connect(source / "market.sqlite3") as db:
        db.execute(
            """CREATE TABLE deliveries(
                 order_id TEXT PRIMARY KEY, document_path TEXT NOT NULL,
                 manifest_path TEXT, car_path TEXT)"""
        )
        db.execute(
            "INSERT INTO deliveries VALUES(?,?,?,?)",
            ("order_1", "/developer/machine/document.md",
             "/developer/machine/manifest.json", "/developer/machine/bundle.car"),
        )

    backup, restored = tmp_path / "backup-remap", tmp_path / "restored-remap"
    command = [sys.executable, str(root / "scripts/mvp-backup.py")]
    subprocess.run([*command, "create", str(source), str(backup)], check=True)
    subprocess.run([*command, "restore", str(backup), str(restored)], check=True)

    with sqlite3.connect(restored / "market.sqlite3") as db:
        document_path, manifest_path, car_path = db.execute(
            "SELECT document_path,manifest_path,car_path FROM deliveries"
        ).fetchone()
    assert Path(document_path) == restored / "ipfs/raw/order_1/document.md"
    assert Path(manifest_path) == restored / "ipfs/raw/order_1/manifest.json"
    assert Path(car_path) == restored / "ipfs/car/order_1-bafyroot.car"
    assert all(Path(item).is_file() for item in (document_path, manifest_path, car_path))
