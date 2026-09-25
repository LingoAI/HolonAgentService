"""Folder import: local files → RAG chunks + ontology facts."""
from backend import ingest_files
from backend.engine.ontology import Ontology


def _onto(tmp_path):
    return Ontology(tmp_path / "graph.json")


def test_scan_folder_filters_and_caps(tmp_path):
    (tmp_path / "a.md").write_text("alpha")
    (tmp_path / "b.txt").write_text("beta")
    (tmp_path / "c.bin").write_bytes(b"\x00\x01")
    files = ingest_files.scan_folder(tmp_path)
    assert [f.name for f in files] == ["a.md", "b.txt"]


def test_scan_folder_rejects_non_dir(tmp_path):
    assert ingest_files.scan_folder(tmp_path / "nope") is None


def test_ingest_folder_counts(tmp_path):
    d = tmp_path / "docs"; d.mkdir()
    (d / "note.md").write_text("I met Dr. Smith at LingoAI.")
    (d / "empty.txt").write_text("   ")
    onto = _onto(tmp_path)
    calls = []
    res = ingest_files.ingest_folder(
        onto, d,
        ingest_text=lambda t, x, tag: (calls.append(t), 2)[1],
        extractor=lambda text, source: [{"subject": "You", "predicate": "did", "object": "met Dr. Smith"}])
    assert res == {"files": 1, "chunks": 2, "facts": 1, "skipped": 1}
    assert calls == ["note.md"]


def test_ingest_folder_error(tmp_path):
    assert ingest_files.ingest_folder(_onto(tmp_path), tmp_path / "nope") == {"error": "not a folder"}


def test_ingest_folder_rejects_empty_path(tmp_path):
    assert ingest_files.ingest_folder(_onto(tmp_path), "") == {"error": "not a folder"}
    assert ingest_files.scan_folder("") is None
