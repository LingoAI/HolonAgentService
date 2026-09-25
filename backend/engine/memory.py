"""Mem0 episodic memory. mem0 2.0.4 quirks: `ollama_base_url` (not base_url),
filters={'user_id':...} (not user_id=), and it needs the `ollama` package or it
blocks on input(). The embedder ALWAYS stays local."""
from functools import lru_cache
from .. import config

USER = "user"


def build_config(model, collection, llm_url, api="ollama"):
    if api == "openai":
        # an OpenAI-compatible server (Model Studio); mem0 takes the base URL
        # and key explicitly so nothing depends on OPENAI_* env vars
        import os
        llm = {"provider": "openai",
               "config": {"model": model, "openai_base_url": llm_url,
                          "api_key": os.getenv("MODEL_STUDIO_API_KEY", "")}}
    else:
        llm = {"provider": "ollama",
               "config": {"model": model, "ollama_base_url": llm_url}}
    return {
        "llm": llm,
        "embedder": {"provider": "ollama",
                     "config": {"model": config.EMBED_MODEL,
                                "ollama_base_url": config.OLLAMA_URL}},
        "vector_store": {"provider": "chroma",
                         "config": {"collection_name": collection,
                                    "path": str(config.DATA_DIR / collection)}},
    }


@lru_cache(maxsize=4)
def _build(model, collection, llm_url, api="ollama"):
    try:
        from mem0 import Memory
        return Memory.from_config(build_config(model, collection, llm_url, api)), None
    except Exception as e:
        return None, str(e)


def _engine(tier=None):
    c = config.tier_config(tier)
    return _build(c["model"], c["collection"], c["llm_url"], c.get("api", "ollama"))


def mem_add(text, tier=None, infer=None):
    """``infer=False`` stores the text verbatim (local embedder only) without
    the tier's LLM distilling it — what the privacy gateway asks for on cloud
    tiers, so the raw turn never goes to the cloud through memory either."""
    mem, _ = _engine(tier)
    if mem is None:
        return
    try:
        mem.add(text, user_id=USER,
                infer=config.tier_config(tier)["infer"] if infer is None else infer)
    except Exception:
        pass


def mem_search(query, tier=None, limit=6):
    mem, _ = _engine(tier)
    if mem is None:
        return []
    try:
        return mem.search(query, filters={"user_id": USER}, limit=limit).get("results") or []
    except Exception:
        return []


def mem_get_all(tier=None):
    mem, err = _engine(tier)
    if mem is None:
        return [], err
    try:
        return (mem.get_all(filters={"user_id": USER}).get("results") or []), None
    except Exception as e:
        return [], str(e)


def mem_delete_matching(text, tier=None):
    """Best-effort delete of memories that mention `text` (case-insensitive).
    Part of the forget flow: forgetting a person also forgets what mem0
    remembered about them. Returns how many were deleted."""
    mem, _ = _engine(tier)
    if mem is None or not text:
        return 0
    n = 0
    try:
        for r in (mem.get_all(filters={"user_id": USER}).get("results") or []):
            if text.lower() in (r.get("memory") or "").lower():
                mem.delete(r["id"])
                n += 1
    except Exception:
        pass
    return n
