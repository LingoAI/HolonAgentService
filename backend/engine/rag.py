"""Document RAG over Chroma (the vector / 'what did I say' memory system).
Uses Chroma's built-in embedding function so retrieval works without Ollama."""
import time
from datetime import datetime
from functools import lru_cache
from .. import config

SUMMARIZE_HINTS = ("summar", "the file", "the document", "uploaded", "this doc",
                   "tldr", "tl;dr", "overview of", "what does it say", "what's in")


def is_summarize_query(q):
    ql = q.lower()
    return any(h in ql for h in SUMMARIZE_HINTS)


def chunk_text(text, size=500, step=400):
    return [text[i:i + size] for i in range(0, len(text), step)] or [text]


@lru_cache(maxsize=1)
def _get_chroma():
    import chromadb
    client = chromadb.PersistentClient(path=str(config.DATA_DIR / "chroma"))
    return client.get_or_create_collection("personal_ontology",
                                            metadata={"hnsw:space": "cosine"})


def _safe_collection():
    try:
        return _get_chroma()
    except Exception:
        return None


def ingest_text(title, text, tag="note"):
    col = _get_chroma()
    ids, docs, metas = [], [], []
    for i, chunk in enumerate(chunk_text(text)):
        ids.append(f"{title.replace(' ', '_')}_{i}_{int(time.time()*1000)}")
        docs.append(chunk)
        metas.append({"title": title, "tag": tag, "chunk": i,
                      "added": datetime.now().isoformat()})
    col.add(ids=ids, documents=docs, metadatas=metas)
    return len(docs)


def retrieve(query, n=6):
    col = _safe_collection()
    if col is None:
        return []
    if not col.count():
        return []
    res = col.query(query_texts=[query], n_results=min(n, col.count()))
    if not res["documents"] or not res["documents"][0]:
        return []
    return [{"text": d, "meta": m} for d, m in zip(res["documents"][0], res["metadatas"][0])]


def recent_document_chunks(max_chunks=14):
    col = _safe_collection()
    if col is None:
        return []
    if not col.count():
        return []
    data = col.get(include=["documents", "metadatas"])
    docs, metas = data.get("documents") or [], data.get("metadatas") or []
    if not metas:
        return []
    latest_title, latest_time = None, ""
    for m in metas:
        if m.get("added", "") >= latest_time:
            latest_time, latest_title = m.get("added", ""), m.get("title")
    items = sorted([(m.get("chunk", 0), d, m) for d, m in zip(docs, metas)
                    if m.get("title") == latest_title], key=lambda x: x[0])
    return [{"text": d, "meta": m} for _, d, m in items[:max_chunks]]


def list_documents():
    col = _safe_collection()
    if col is None:
        return []
    if not col.count():
        return []
    metas = col.get(include=["metadatas"]).get("metadatas") or []
    by_title = {}
    for m in metas:
        t = m.get("title", "?")
        by_title.setdefault(t, {"title": t, "tag": m.get("tag", "note"), "chunks": 0})
        by_title[t]["chunks"] += 1
    return list(by_title.values())


def count():
    try:
        return _get_chroma().count()
    except Exception:
        return 0


def delete_document(title):
    """Remove every chunk of one ingested document. Returns chunks deleted."""
    col = _safe_collection()
    if col is None:
        return 0
    got = col.get(where={"title": title})
    ids = got.get("ids") or []
    if ids:
        col.delete(ids=ids)
    return len(ids)
