"""Holon FastAPI backend: serves the SPA and the JSON/SSE API over the engine."""
import hashlib
import json
import os
from fastapi import FastAPI, UploadFile, File, Request
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, trajectory, personal
from .engine import llm, memory, rag, voice, context, router, privacy
from .engine.ontology import Ontology, TYPE_COLORS, NODE_TYPES
from .sovereignty import access, pod, solid
from .metalife import sim as metalife
from .marketplace import preferences
from .sovereignty import bridge
from .marketplace import xlayer, mvp, mainnet_proof

app = FastAPI(title="LingoAI X Layer Agent Marketplace")
from .security import ReadOnlyMiddleware, SecurityHeadersMiddleware, TokenAuthMiddleware
app.add_middleware(ReadOnlyMiddleware)
app.add_middleware(xlayer.XLayerBoundary)
app.add_middleware(TokenAuthMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.include_router(xlayer.router)
app.include_router(mvp.router)
app.include_router(mainnet_proof.ROUTER)
ONTO = Ontology(config.DATA_DIR / "ontology" / "graph.json")
HISTORY = config.DATA_DIR / "history.json"


def _load_history():
    try:
        return json.loads(HISTORY.read_text())
    except Exception:
        return []


def _save_history(msgs):
    from .atomic_io import atomic_write_json
    atomic_write_json(HISTORY, msgs)


@app.on_event("startup")
def _startup_snapshot():
    from . import backup
    try:
        backup.snapshot()   # at most one per day; never blocks startup on failure
    except Exception:
        pass


@app.get("/health")
def health():
    """Liveness for the reverse proxy and the host's health check: answers
    without touching Ollama or the chain. /api/status is the detailed one.
    ``revision`` is the deployed git revision the image was built from, so a
    release can be matched to a commit without shell access to the box."""
    return {"ok": True, "revision": os.getenv("HOLON_REVISION", "")}


@app.get("/api/status")
def status():
    sel = config.get_tier()
    c = config.tier_config(sel)  # resolves "auto" → cloud config for display
    auto = sel == "auto"
    resolved = "cloud" if auto else sel
    return {"application": "xlayer", "ollama_up": llm.ollama_running(),
            # public read-only profile: the UI hides local-only setup hints and
            # labels what is simulated when this is set
            "readonly": os.getenv("HOLON_READONLY", "").strip() in ("1", "true", "yes"),
            "tier": "cloud" if auto else sel,      # the concrete tier shown
            "selection": sel,                       # what the user picked
            "model": "auto" if auto else c["model"],
            "label": "Auto · routes per query" if auto else c["label"],
            "tagline": c["tagline"],
            "local": c["local"], "embedder_local": True,
            "has_key": bool(config.load_api_key()),
            # Configuration presence only: neither field proves provider health
            # or key validity. has_key remains the legacy Ollama-key flag.
            "provider": ("ollama-local" if c["local"] else
                         "openai-compatible" if c.get("api") == "openai" else "ollama-cloud"),
            # auto routes locally when Ollama is up, so it counts as configured then too
            "provider_configured": bool(c.get("llm_url") and c.get("model") and
                                        (c["local"] or llm.cloud_configured(resolved)
                                         or (auto and llm.ollama_running()))),
            "selections": config.SELECTIONS,
            "types": NODE_TYPES, "colors": TYPE_COLORS}


@app.get("/api/stats")
def stats():
    rows, _ = memory.mem_get_all()
    s = ONTO.stats()
    return {"memories": len(rows), "docs": len(rag.list_documents()),
            "nodes": s["nodes"], "edges": s["edges"]}


@app.get("/api/graph")
def graph(type: str = "", q: str = ""):
    return ONTO.to_cytoscape(filter_type=type or None, q=q or None)


@app.get("/api/node/{nid}")
def node(nid: str):
    return ONTO.node_detail(nid)


@app.get("/api/graph/duplicates")
def graph_duplicates():
    return ONTO.find_duplicates()


@app.post("/api/graph/merge")
async def graph_merge(request: Request):
    body = await request.json()
    ok = ONTO.merge_nodes(body.get("keep", ""), body.get("merge", ""))
    return {"ok": ok, **ONTO.stats()}


@app.get("/api/memory")
def get_memory(q: str = ""):
    rows, _ = memory.mem_get_all()
    if q:
        rows = [r for r in rows if q.lower() in r.get("memory", "").lower()]
    return [{"id": r.get("id"), "memory": r.get("memory", "")} for r in rows]


@app.get("/api/sources")
def sources():
    return rag.list_documents()


PRIVACY_DOC_NOTE = ("Redaction uses your ontology as its dictionary: names not yet in your graph "
                    "are not redacted from documents. Add the people and organisations first, "
                    "or ingest on the local tier.")
PRIVACY_DOC_LOCAL_NOTE = ("Document text stayed on this machine: on a cloud tier Holon does not send "
                          "documents to the cloud model unless you allow it in Privacy settings "
                          "(names not yet in your ontology cannot be redacted). The document is "
                          "searchable here; no facts were extracted.")


def _public_instance():
    return os.getenv("HOLON_READONLY", "").strip() in ("1", "true", "yes")


def _documents_may_go_to_cloud(tier, policy=None):
    """Local tier: nothing leaves, extraction always runs. Cloud tier: only when
    the user's privacy policy allows documents to be sent (default: no)."""
    if config.tier_config(tier)["local"]:
        return True
    policy = preferences.get().get("privacy") if policy is None else policy
    return (policy or {}).get("cloud_documents") is True


def _gateway(tier):
    """The cloud boundary for this request: every string that leaves for a
    cloud model — chat, summariser, extraction of turns AND documents — goes
    through one gateway built from the twin's own graph and policy. A local
    tier gets a disabled gateway: nothing leaves."""
    if config.tier_config(tier)["local"]:
        return privacy.Gateway(enabled=False)
    return privacy.Gateway.from_ontology(ONTO, preferences.get().get("privacy"))


@app.post("/api/ingest")
async def ingest(request: Request):
    """Accept either JSON {title,text,tag} (paste) or multipart with a `file`.
    Content-type aware so we never mix Form() params with request.json()."""
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("multipart/form-data"):
        form = await request.form()
        up = form["file"]
        text = (await up.read()).decode("utf-8", errors="ignore")
        ttl = form.get("title") or up.filename
        tag = form.get("tag", "file")
    else:
        body = await request.json()
        text, ttl, tag = body.get("text", ""), body.get("title", "Untitled"), body.get("tag", "note")
    if not text.strip():
        return JSONResponse({"error": "empty"}, status_code=400)
    chunks = rag.ingest_text(ttl, text, tag)
    tier = config.get_tier()
    gw = _gateway(tier)
    if _documents_may_go_to_cloud(tier):
        facts = ONTO.extract_and_add(text[:4000], source=f"doc:{ttl}", tier=tier,
                                     llm_call=gw.wrap_once(llm.chat_once) if gw.enabled else None)
        note = {"privacy_note": PRIVACY_DOC_NOTE} if gw.enabled else {}
    else:
        facts, note = [], {"privacy_note": PRIVACY_DOC_LOCAL_NOTE, "documents_local_only": True}
    return {"chunks": chunks, "facts_added": len(facts), "privacy": gw.stats(), **note}


@app.post("/api/ingest/folder")
async def ingest_folder_endpoint(request: Request):
    from . import ingest_files
    body = await request.json()
    tier = config.get_tier()
    gw = _gateway(tier)
    to_cloud = _documents_may_go_to_cloud(tier)
    if not to_cloud:
        extractor = lambda text, source: []                     # noqa: E731 — index only, nothing leaves
    elif gw.enabled:
        extractor = lambda text, source: ONTO.extract_and_add(   # noqa: E731
            text, source=source, tier=tier, llm_call=gw.wrap_once(llm.chat_once))
    else:
        extractor = None
    res = ingest_files.ingest_folder(ONTO, body.get("path", ""),
                                     tag=body.get("tag", "import"), tier=tier, extractor=extractor)
    if "error" in res:
        return JSONResponse(res, status_code=400)
    res["privacy"] = gw.stats()
    if not to_cloud:
        res["privacy_note"], res["documents_local_only"] = PRIVACY_DOC_LOCAL_NOTE, True
    elif gw.enabled:
        res["privacy_note"] = PRIVACY_DOC_NOTE
    return res


@app.post("/api/voice")
async def post_voice(file: UploadFile = File(...)):
    data = await file.read()
    ext = (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
    suffix = "." + (ext if ext.isalnum() and len(ext) <= 5 else "wav")
    text, lang, err = voice.translate_bytes(data, suffix=suffix)
    if err:
        return JSONResponse({"error": str(err)}, status_code=500)
    return {"text": text, "lang": voice.LANG_NAMES.get(lang, lang or "speech")}


@app.post("/api/tier")
async def set_tier(request: Request):
    tier = (await request.json()).get("tier", config.DEFAULT_TIER)
    if tier not in config.SELECTIONS:
        return JSONResponse({"error": "bad tier"}, status_code=400)
    config.set_tier(tier)
    model = "auto" if tier == "auto" else config.tier_config(tier)["model"]
    return {"tier": tier, "model": model}


@app.post("/api/reset")
def reset():
    ONTO.reset()
    _save_history([])
    return {"ok": True}


@app.post("/api/seed")
def seed_endpoint():
    from .seed import seed_all
    seed_all(ONTO)
    return {"ok": True, **ONTO.stats()}


@app.post("/api/chat")
async def chat(request: Request):
    body = await request.json()
    user_input = body.get("message", "").strip()
    selection = config.get_tier()
    decision = router.route(user_input, selection, ONTO)
    tier = decision["tier"]  # concrete tier for llm + memory + extraction
    # PrivacyGateway: on a cloud tier, every string that leaves — system prompt,
    # transcript, extraction input, summariser input — is redacted against the
    # user's own ontology and policy, and every result is restored. A local
    # tier gets a disabled gateway: nothing leaves.
    gw = _gateway(tier)
    allow_documents = _documents_may_go_to_cloud(tier)

    def event_stream():
        import time as _time
        from .engine.context import compress_to_budget, estimate_tokens
        t0 = _time.time()
        history = _load_history()
        history.append({"role": "user", "content": user_input})
        _save_history(history)  # persist the user turn now so a mid-stream crash can't lose it
        # with the gateway on, memory stores the turn verbatim (local embedder)
        # instead of sending it to the cloud LLM to distil
        memory.mem_add(user_input, tier=tier, infer=False if gw.enabled else None)
        reply, err, ctx_tokens = "", None, 0
        try:
            graph_text = ONTO.subgraph_for(user_input)
            system = context.build_system(user_input, tier=tier, graph_text=graph_text,
                                          allow_documents=allow_documents)
            # Full transcript stays on disk; older turns are condensed (not dropped)
            # into a framed summary so the twin never forgets the conversation. The
            # summariser LLM call only fires when the budget is actually exceeded.
            sent = compress_to_budget(context.model_messages(history), budget_tokens=24000,
                                      llm_call=gw.wrap_once(llm.chat_once), tier=tier)
            system_out, sent_out = gw.redact(system), gw.redact_messages(sent)
            ctx_tokens = estimate_tokens(system) + sum(
                estimate_tokens(m.get("content", "")) for m in sent)
            # Tell the client which tier handles this turn, why, and what was
            # redacted before it left — before the first token.
            route_info = {**decision, "privacy": gw.stats(), "documents_local_only": not allow_documents}
            if not allow_documents:
                route_info["context_note"] = context.DOCUMENTS_WITHHELD_NOTE
            yield f"event: route\ndata: {json.dumps(route_info)}\n\n"
            for tok in gw.stream_restore(llm.chat_stream(sent_out, tier, system=system_out)):
                reply += tok
                yield f"event: token\ndata: {json.dumps(tok)}\n\n"
            if not reply:
                raise llm.LLMError("The model returned no response. Please retry.", kind="empty")
        except Exception as e:
            err = str(e)
            trajectory.log_turn({"tier": tier, "status": "failed", "partial": bool(reply),
                                 "reply_chars": len(reply), "error": err})
            yield f"event: error\ndata: {json.dumps(str(e))}\n\n"
            return  # error is terminal; no normal reply, extraction or done
        # a failed turn is recorded as an error event, never as an empty or
        # error-text "answer" in the transcript
        if reply:
            history.append({"role": "assistant", "content": reply})
        _save_history(history)
        turn_id = f"turn:{len(history)}"
        facts_added = 0
        for fact in ONTO.extract_and_add(user_input, source=turn_id, tier=tier,
                                         llm_call=gw.wrap_once(llm.chat_once) if gw.enabled else None):
            facts_added += 1
            # Tag the object's type + color so the live graph node renders correctly.
            otype = ONTO.g.nodes.get(fact["object"], {}).get("type", "Topic")
            fact = {**fact, "type": otype,
                    "colors": {fact["object"]: TYPE_COLORS.get(otype, "#9aa0a6")}}
            yield f"event: fact\ndata: {json.dumps(fact)}\n\n"
        yield f"event: paths\ndata: {json.dumps(ONTO.reasoning_paths(user_input))}\n\n"
        # Append-only audit record of the turn — what ran, why, cost, and effect.
        # The raw question is kept only on a private instance (it is the owner's
        # own audit trail); a public instance records length and digest.
        trajectory.log_turn({
            "tier": tier, "reason": decision.get("reason"), "auto": decision.get("auto"),
            "query": None if _public_instance() else user_input,
            "query_len": len(user_input),
            "query_sha256": hashlib.sha256(user_input.encode()).hexdigest()[:16],
            "context_tokens": ctx_tokens,
            "reply_chars": len(reply), "facts_added": facts_added, "privacy": gw.stats(),
            "latency_ms": int((_time.time() - t0) * 1000), "error": err})
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/trajectory")
def get_trajectory(limit: int = 50):
    return trajectory.read_trajectory(limit=limit)


@app.get("/api/history")
def history():
    return _load_history()


@app.get("/api/backups")
def backups_list():
    from . import backup
    return [{"file": p.name, "bytes": p.stat().st_size} for p in backup.list_backups()]


@app.post("/api/backup")
def backup_now():
    from . import backup
    p = backup.snapshot(force=True)
    return {"created": p.name if p else None}


# ---- Data sovereignty: WebID, portable Pod, revocable access -------------
@app.get("/api/webid")
def webid():
    return pod.webid_document(ONTO)


@app.get("/api/pod/export")
def pod_export():
    return pod.export_bundle(ONTO)


@app.get("/api/pod/export.cypher")
def pod_export_cypher():
    from fastapi.responses import PlainTextResponse
    from .cypher import export_cypher
    return PlainTextResponse(export_cypher(ONTO),
                             headers={"Content-Disposition": "attachment; filename=holon.cypher"})


@app.post("/api/pod/import")
async def pod_import(request: Request):
    bundle = (await request.json()).get("bundle") or {}
    count = pod.import_bundle(ONTO, bundle)
    ONTO.save()
    return {"count": count, **ONTO.stats()}


@app.get("/api/access")
def access_list():
    # Single-user localhost: the grants are the owner's own, token included.
    return access.list_grants()


@app.post("/api/access")
async def access_grant(request: Request):
    body = await request.json()
    return access.grant(body.get("grantee", ""), body.get("scopes", []))


@app.post("/api/access/revoke")
async def access_revoke(request: Request):
    gid = (await request.json()).get("id", "")
    return {"revoked": access.revoke(gid)}


@app.get("/api/share/{token}")
def access_share(token: str):
    # Proves revocation end-to-end: a revoked/unknown token returns denied.
    return access.scoped_graph(ONTO, token)


# ---- Stage D · Data capital (SIMULATION) ---------------------------------
@app.get("/api/metalife/assets")
def metalife_assets():
    return metalife.data_assets(ONTO)


@app.post("/api/metalife/compute")
async def metalife_compute(request: Request):
    body = await request.json()
    return metalife.compute_to_data(ONTO, body.get("type", ""), body.get("op", "count"))


@app.post("/api/metalife/offer")
async def metalife_offer(request: Request):
    body = await request.json()
    return metalife.marketplace_offer(ONTO, body.get("type", ""), body.get("price", 0))


@app.post("/api/metalife/sell")
async def metalife_sell(request: Request):
    body = await request.json()
    return metalife.simulate_sale(body.get("type", ""))


@app.post("/api/metalife/h2h")
async def metalife_h2h(request: Request):
    body = await request.json()
    return metalife.h2h_message(body.get("peer", ""), body.get("kind", "handshake"))


@app.get("/api/metalife/network")
def metalife_network():
    metalife.seed_peers()
    return {**metalife.h2h_network(), "ledger": metalife.ledger()}


@app.get("/api/metalife/ledger")
def metalife_ledger():
    return metalife.ledger()


# ---- Personal privacy preferences -----------------------------------------
@app.get("/api/holon/preferences")
def holon_preferences():
    """The policy the Holon applies when it shops: budget, risk, protocols,
    chains, authority. User-set; nothing inferred."""
    return {"ok": True, "preferences": preferences.get(),
            "options": {"risk": preferences.RISKS, "authority": preferences.AUTHORITIES,
                        "protocols": preferences.PROTOCOLS, "networks": preferences.NETWORKS,
                        "privacy_types": preferences.PRIVACY_TYPES,
                        "privacy_patterns": preferences.PRIVACY_PATTERNS}}


@app.post("/api/holon/preferences")
async def holon_preferences_set(request: Request):
    body = await request.json()
    if body.get("reset"):
        return preferences.reset()
    out = preferences.update(body)
    return out if out["ok"] else JSONResponse(out, status_code=400)



# ---- LingoAI Bridge: SOLID Pod <-> chain integration ----------------------
@app.get("/api/pod/ontology.ttl")
def pod_ontology_turtle():
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(bridge.ontology_turtle(ONTO), media_type="text/turtle")


@app.post("/api/bridge/attest")
async def bridge_attest(request: Request):
    body = await request.json()
    if body.get("pod"):
        att = bridge.pod_consent_attestation(ONTO, scope=body.get("scope", "contribution"))
        return JSONResponse(att, status_code=409) if att.get("ok") is False else att
    return bridge.consent_attestation(ONTO, scope=body.get("scope", "contribution"))


# ---- Live SOLID Pod (Community Solid Server + Solid-OIDC) ------------------
@app.get("/api/pod/solid/status")
def solid_status():
    return solid.status()


@app.post("/api/pod/solid/publish")
async def solid_publish(request: Request):
    """Write the ontology into the user's Pod and set the ACL that authorizes
    the given readers — the sovereign half of Pod → consent → chain."""
    raw = await request.body()
    body = json.loads(raw) if raw else {}
    if not solid.configured():
        return JSONResponse({"ok": False, "error": "no Pod configured"}, status_code=409)
    readers = body.get("readers") or []
    if isinstance(readers, str):
        readers = [readers]
    for r in readers:
        if not isinstance(r, str) or not r.startswith(("http://", "https://")):
            return JSONResponse({"ok": False, "error": "readers must be WebID URLs"},
                                status_code=400)
    try:
        result = solid.publish(ONTO, readers=readers,
                               scope=body.get("scope", "pod-publish"),
                               purpose=body.get("purpose", "holon marketplace data access"),
                               valid_days=int(body.get("valid_days", 90)))
    except Exception as exc:  # noqa: BLE001 — surface Pod/network failures as JSON
        return JSONResponse({"ok": False, "error": str(exc)[:200]}, status_code=502)
    result["ok"] = bool(result.get("write", {}).get("ok"))
    # Chain-facing half: the pod-gated attestation — the Bridge (its own
    # WebID) re-reads what was just granted and verifies the consent document
    # before signing; refusal detail is returned instead of a signature.
    if result["ok"]:
        result["attestation"] = bridge.pod_consent_attestation(
            ONTO, scope=body.get("scope", "pod-publish"))
    return result


@app.post("/api/pod/solid/revoke")
def solid_revoke():
    """User-side revocation: only the owner keeps access; the Bridge's next
    read (and therefore any further attestation) is refused by the server."""
    if not solid.configured():
        return JSONResponse({"ok": False, "error": "no Pod configured"}, status_code=409)
    try:
        return solid.revoke()
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(exc)[:200]}, status_code=502)


@app.get("/api/pod/solid/read")
def solid_read(public: bool = False):
    """Read the ontology back from the Pod. `public=1` drops the credentials —
    a 401 there is the proof that Pod-side authorization is real."""
    if not solid.configured():
        return JSONResponse({"ok": False, "error": "no Pod configured"}, status_code=409)
    try:
        return solid.get_turtle(authenticated=not public)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": str(exc)[:200]}, status_code=502)


# ---- Personal data → ontology (deterministic, no-LLM structured entry) ----
@app.post("/api/personal/event")
async def personal_event(request: Request):
    body = await request.json()
    if not (body.get("title") or "").strip():
        return JSONResponse({"error": "empty"}, status_code=400)
    return personal.add_event(ONTO, body.get("title", ""), when=body.get("when"),
                              where=body.get("where"), who=body.get("who") or [])


@app.post("/api/personal/contact")
async def personal_contact(request: Request):
    body = await request.json()
    if not (body.get("name") or "").strip():
        return JSONResponse({"error": "empty"}, status_code=400)
    return personal.add_contact(ONTO, body.get("name", ""), org=body.get("org"),
                                relationship=body.get("relationship"))


@app.get("/api/personal/events")
def personal_events():
    return personal.list_events(ONTO)


@app.get("/api/personal/contacts")
def personal_contacts():
    return personal.list_contacts(ONTO)


@app.post("/api/forget")
async def forget(request: Request):
    """Right-to-forget: drop the node + edges, then best-effort forget matching
    mem0 memories. Documents are deleted separately via /api/source/delete."""
    label = ((await request.json()).get("node") or "").strip()
    if not label:
        return JSONResponse({"error": "empty"}, status_code=400)
    res = ONTO.forget_node(label)
    res["memories_deleted"] = memory.mem_delete_matching(label) if res["removed"] else 0
    return res


@app.post("/api/source/delete")
async def source_delete(request: Request):
    title = ((await request.json()).get("title") or "").strip()
    if not title:
        return JSONResponse({"error": "empty"}, status_code=400)
    return {"chunks_deleted": rag.delete_document(title)}


# Serve the SPA (mounted last so /api/* wins).
app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIR), html=True), name="spa")
