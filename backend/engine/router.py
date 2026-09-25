"""Tiered auto-router: a deterministic, no-LLM complexity heuristic that decides
whether a query needs frontier-class Cloud reasoning or can be served by the
private Local model. Manual selections are always honored; "auto" routes per query.
"""

from .. import config

# Reasoning markers that hint at multi-hop / explanatory queries.
REASONING_MARKERS = [
    "why", "how", "compare", "explain", "relationship", "because",
    "connect", "across", "versus", "trade-off",
]


def complexity(query, onto=None):
    """Score a query 0..1 on how much reasoning it needs. Pure + deterministic.

    Signals: length, reasoning markers, question depth, and whether multiple
    known ontology entities are referenced (multi_hop)."""
    q = (query or "").strip()
    ql = q.lower()
    signals = []
    score = 0.0

    # Length: longer prompts tend to carry more constraints.
    words = len(q.split())
    if words >= 12:
        score += 0.3
        signals.append("long query")
    elif words >= 6:
        score += 0.15
        signals.append("medium query")

    # Reasoning markers.
    markers = [m for m in REASONING_MARKERS if m in ql]
    if markers:
        score += min(0.4, 0.15 * len(markers))
        signals.append("reasoning markers: " + ", ".join(markers))

    # Question depth: multiple clauses / multiple question marks.
    if ql.count("?") > 1 or " and " in ql:
        score += 0.15
        signals.append("multi-part question")

    # Multiple known ontology entities → multi-hop.
    multi_hop = False
    if onto is not None:
        try:
            seeds = onto._seed_nodes_for(q)
            # _seed_nodes_for falls back to "all non-root nodes" when nothing
            # actually matches; treat that fallback as no real hit.
            matched = [s for s in seeds if s.lower() in ql
                       or any(w in s.lower() for w in ql.split() if len(w) > 3)]
            if len(matched) > 1:
                multi_hop = True
                score += 0.35
                signals.append(f"references {len(matched)} known facts")
            elif len(matched) == 1:
                signals.append("references 1 known fact")
        except Exception:
            pass

    score = max(0.0, min(1.0, score))
    if not signals:
        signals.append("simple recall")
    return {"score": round(score, 3), "signals": signals, "multi_hop": multi_hop}


def route(query, selection, onto=None):
    """Decide the concrete tier to use. Manual selection wins; "auto" picks
    Cloud for complex / multi-hop queries, Local for simple recall."""
    if selection in config.TIERS:
        return {"tier": selection, "reason": "manual", "auto": False}

    c = complexity(query, onto=onto)
    if c["score"] >= 0.5 or c["multi_hop"]:
        if c["multi_hop"]:
            reason = "multi-hop reasoning across facts → Cloud"
        else:
            reason = "complex reasoning → Cloud"
        tier = "cloud"
    else:
        reason = "simple recall → Local"
        tier = "local"
    return {"tier": tier, "reason": reason, "auto": True}
