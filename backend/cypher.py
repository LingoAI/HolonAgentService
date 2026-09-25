"""Export the ontology as Neo4j Cypher MERGE statements — open your twin's graph
in Neo4j Desktop / Aura / Bloom with one paste. Pure text generation: no driver,
no server dependency, so the sovereign zero-dep core stays intact."""


def _esc(s):
    return str(s).replace("\\", "\\\\").replace('"', '\\"')


def _rel_type(predicate):
    # Cypher relationship types are conventionally SCREAMING_SNAKE.
    return "".join(c if (c.isalnum() or c == "_") else "_" for c in str(predicate)).upper()


def export_cypher(onto):
    """Render every node and edge as idempotent MERGE statements (re-runnable)."""
    lines = ["// Holon ontology export — paste into Neo4j Browser or `cypher-shell`",
             "// Idempotent: MERGE keeps re-imports duplicate-free.", ""]
    for nid, a in onto.g.nodes(data=True):
        label = a.get("type", "Topic")
        props = [f'name: "{_esc(a.get("label", nid))}"']
        if a.get("provenance"):
            props.append(f'source: "{_esc(a["provenance"][0])}"')
        if a.get("t_first_seen"):
            props.append(f'first_seen: "{_esc(a["t_first_seen"])}"')
        lines.append(f'MERGE (:{label} {{{", ".join(props)}}})')
    lines.append("")
    for s, t, e in onto.g.edges(data=True):
        props = []
        if e.get("provenance"):
            props.append(f'source: "{_esc(e["provenance"][0])}"')
        if e.get("confidence") is not None:
            props.append(f'confidence: {e["confidence"]}')
        prop_str = f' {{{", ".join(props)}}}' if props else ""
        lines.append(f'MATCH (a {{name: "{_esc(s)}"}}), (b {{name: "{_esc(t)}"}})\n'
                     f'MERGE (a)-[:{_rel_type(e.get("predicate", "related_to"))}{prop_str}]->(b);')
    return "\n".join(lines) + "\n"
