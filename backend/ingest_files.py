"""Bulk-import local files into the twin: each readable file becomes RAG chunks
plus ontology facts. Local-first by design — the folder is a path on the user's
own machine, so no upload step and no size ceiling beyond the per-file cap."""
from pathlib import Path

TEXT_EXTS = {".txt", ".md", ".markdown", ".rst", ".csv", ".json", ".log"}
MAX_FILES = 200          # one import call stays bounded
MAX_CHARS = 100_000      # per file


def read_file_text(path):
    p = Path(path)
    ext = p.suffix.lower()
    if ext == ".pdf":
        try:
            from pypdf import PdfReader
            return "\n".join((pg.extract_text() or "") for pg in PdfReader(str(p)).pages)[:MAX_CHARS]
        except Exception:
            return ""
    if ext in TEXT_EXTS:
        try:
            return p.read_text(errors="ignore")[:MAX_CHARS]
        except Exception:
            return ""
    return ""


def scan_folder(folder):
    """Importable files under `folder` (recursive, sorted, capped). None if not a dir."""
    if not str(folder).strip():
        return None
    p = Path(folder).expanduser()
    if not p.is_dir():
        return None
    out = []
    for f in sorted(p.rglob("*")):
        if f.is_file() and (f.suffix.lower() in TEXT_EXTS or f.suffix.lower() == ".pdf"):
            out.append(f)
            if len(out) >= MAX_FILES:
                break
    return out


def ingest_folder(onto, folder, tag="import", tier="cloud", ingest_text=None, extractor=None):
    """Ingest every readable file: RAG chunks + ontology extraction (first 4k chars,
    same cap as /api/ingest). `ingest_text`/`extractor` are injectable for tests."""
    if ingest_text is None:
        from .engine import rag
        ingest_text = rag.ingest_text
    if extractor is None:
        extractor = lambda text, source: onto.extract_and_add(text, source=source, tier=tier)
    files = scan_folder(folder)
    if files is None:
        return {"error": "not a folder"}
    res = {"files": 0, "chunks": 0, "facts": 0, "skipped": 0}
    for f in files:
        text = read_file_text(f)
        if not text.strip():
            res["skipped"] += 1
            continue
        res["chunks"] += ingest_text(f.name, text, tag)
        res["facts"] += len(extractor(text[:4000], f"doc:{f.name}"))
        res["files"] += 1
    return res
