"""Holon configuration: paths, sovereignty tiers, persisted tier state, key loading."""
import os
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent          # .../holon
DATA_DIR = BASE_DIR / "data"
FRONTEND_DIR = BASE_DIR / "frontend"
DATA_DIR.mkdir(parents=True, exist_ok=True)

OLLAMA_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_CLOUD = os.getenv("OLLAMA_CLOUD_URL", "https://ollama.com")
EMBED_MODEL = os.getenv("EMBED_MODEL", "nomic-embed-text")

# The doc's sovereignty spine, reduced to the two tiers this machine can run.
# Tier 1 (local): bounded, fully private. Tier 3 (cloud): frontier-class, free,
# but prompts leave the machine. Embedder + Whisper always stay local.
# Memory is ONE store across tiers ("mem0") — like the ontology graph and the
# documents — so it's a single lifelong twin, not split by which brain you used.
# The tier only changes the chat model and the extraction `infer` strategy.
TIERS = {
    "local": {"model": os.getenv("LLM_MODEL", "qwen3.5:2b"), "infer": False,
              "local": True, "llm_url": OLLAMA_URL, "collection": "mem0",
              "label": "Tier 1 · Local", "tagline": "On-device · fully private"},
    "cloud": {"model": os.getenv("CLOUD_MODEL", "gpt-oss:120b-cloud"), "infer": True,
              "local": False, "llm_url": OLLAMA_CLOUD, "collection": "mem0",
              "label": "Tier 3 · Cloud", "tagline": "Frontier-class · prompts leave the machine"},
}

# Qwen first: with a Model Studio key the cloud tier is Alibaba Cloud Model
# Studio through its OpenAI-compatible endpoint (the same wire format a later
# TokenSwitch router speaks, so that swap is a base-URL change). Without the
# key the Ollama-cloud tier above stays as it was.
MODEL_STUDIO_URL = os.getenv("MODEL_STUDIO_BASE_URL",
                             "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").rstrip("/")


def _model_studio_tier(env=None):
    env = os.environ if env is None else env
    if not (env.get("MODEL_STUDIO_API_KEY") or "").strip():
        return None
    return {"model": (env.get("MODEL_STUDIO_MODEL") or "qwen-plus").strip(), "infer": True,
            "local": False, "llm_url": MODEL_STUDIO_URL, "api": "openai", "collection": "mem0",
            "label": "Tier 3 · Qwen (Model Studio)",
            "tagline": "Alibaba Cloud Model Studio · prompts leave the machine, redacted first"}


_studio = _model_studio_tier()
if _studio:
    TIERS["cloud"] = _studio


def _custom_tier(env=None):
    """Optional third tier: any Ollama-API-compatible server the user points us
    at (a remote Ollama box, a home GPU rig). Selectable only when configured
    via HOLON_CUSTOM_URL + HOLON_CUSTOM_MODEL."""
    env = os.environ if env is None else env
    url = (env.get("HOLON_CUSTOM_URL") or "").strip()
    model = (env.get("HOLON_CUSTOM_MODEL") or "").strip()
    if not (url and model):
        return None
    return {"model": model, "infer": True, "local": False, "llm_url": url,
            "collection": "mem0", "label": "Custom · BYO endpoint",
            "tagline": "Your own Ollama-compatible server"}


_custom = _custom_tier()
if _custom:
    TIERS["custom"] = _custom

DEFAULT_TIER = "cloud"
# A "selection" is what the user picks; "auto" lets the router decide per query.
# Concrete tiers are still only the keys of TIERS.
SELECTIONS = list(TIERS) + ["auto"]


def load_api_key():
    """Cloud auth key: env OLLAMA_API_KEY, else holon/.ollama_key, else the legacy
    demo/.ollama_key. Re-export to env so mem0's ollama client authenticates too."""
    k = os.getenv("OLLAMA_API_KEY", "").strip()
    if not k:
        for f in (BASE_DIR / ".ollama_key", BASE_DIR.parent / "demo" / ".ollama_key"):
            if f.exists():
                k = f.read_text().strip()
                break
    if k:
        os.environ["OLLAMA_API_KEY"] = k
    return k


def _state_file():
    return DATA_DIR / "state.json"


def get_tier():
    try:
        return json.loads(_state_file().read_text()).get("tier", DEFAULT_TIER)
    except Exception:
        return DEFAULT_TIER


def selection():
    """The raw stored selection — may be "local", "cloud", or "auto"."""
    return get_tier()


def set_tier(tier):
    if tier not in SELECTIONS:
        raise ValueError(f"Unknown selection: {tier!r}")
    from .atomic_io import atomic_write_json
    atomic_write_json(_state_file(), {"tier": tier})
    return tier


def tier_config(tier=None):
    t = tier or get_tier()
    # "auto" is a selection, not a concrete tier — fall back to cloud config for
    # display purposes so callers that haven't resolved "auto" don't KeyError.
    if t == "auto":
        t = "cloud"
    return TIERS[t]
