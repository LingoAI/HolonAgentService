import importlib.util
import sqlite3
from pathlib import Path


def load_restore_module():
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("restore_mvp_ipfs", root / "scripts/restore-mvp-ipfs.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecordingStorage:
    configured = True

    def __init__(self, cids):
        self.cids = cids
        self.pinned = []
        self.imported = []

    def pin_bytes(self, name, raw):
        self.pinned.append((name, raw))
        return self.cids[raw]

    def import_car(self, path, expected):
        self.imported.append((Path(path), expected))


def test_restore_ipfs_repins_all_recorded_objects_and_imports_car(tmp_path):
    module = load_restore_module()
    provider_raw, task_raw = b'{"type":"provider"}', b'{"type":"task"}'
    document_raw, manifest_raw = b"# result", b'{"type":"delivery"}'
    cids = {
        provider_raw: "b" + "a" * 58,
        task_raw: "b" + "c" * 58,
        document_raw: "b" + "d" * 58,
        manifest_raw: "b" + "e" * 58,
    }
    provider_owner, task_uid, order_id = "0x" + "11" * 20, "task_1", "order_1"
    paths = {
        "provider": tmp_path / "ipfs/raw" / f"provider-{provider_owner}" / "metadata.json",
        "task": tmp_path / "ipfs/raw" / task_uid / "task.json",
        "document": tmp_path / "ipfs/raw" / order_id / "document.md",
        "manifest": tmp_path / "ipfs/raw" / order_id / "manifest.json",
        "car": tmp_path / "ipfs/car" / "order_1-bafyroot.car",
    }
    for key, raw in (("provider", provider_raw), ("task", task_raw),
                     ("document", document_raw), ("manifest", manifest_raw)):
        paths[key].parent.mkdir(parents=True, exist_ok=True)
        paths[key].write_bytes(raw)
    paths["car"].parent.mkdir(parents=True, exist_ok=True)
    paths["car"].write_bytes(b"car")
    with sqlite3.connect(tmp_path / "market.sqlite3") as db:
        db.executescript(
            """CREATE TABLE providers(owner TEXT,metadata_uri TEXT,active INTEGER);
               CREATE TABLE tasks(uid TEXT,manifest_cid TEXT);
               CREATE TABLE deliveries(order_id TEXT,document_path TEXT,manifest_path TEXT,
                 car_path TEXT,file_cid TEXT,manifest_cid TEXT);"""
        )
        db.execute("INSERT INTO providers VALUES(?,?,1)", (provider_owner, f"ipfs://{cids[provider_raw]}"))
        db.execute("INSERT INTO tasks VALUES(?,?)", (task_uid, cids[task_raw]))
        db.execute("INSERT INTO deliveries VALUES(?,?,?,?,?,?)",
                   (order_id, str(paths["document"]), str(paths["manifest"]), str(paths["car"]),
                    cids[document_raw], cids[manifest_raw]))

    storage = RecordingStorage(cids)
    result = module.restore_ipfs(tmp_path, storage)
    assert result["pinnedObjects"] == 4
    assert result["importedCars"] == 1
    assert {raw for _, raw in storage.pinned} == set(cids)
    assert storage.imported == [(paths["car"], {
        cids[document_raw]: document_raw, cids[manifest_raw]: manifest_raw,
    })]
