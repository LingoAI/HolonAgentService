# holon/backend/tests/test_ontology_query.py
from backend.engine.ontology import Ontology

def _seed(tmp_path):
    o = Ontology(tmp_path / "g.json")
    nt = {"You": "Person", "Metformin": "Medication", "Dr. Smith": "Person",
          "Type 2 Diabetes": "Condition"}
    o.upsert_relation("You", "takes", "Metformin", source="t1", node_types=nt)
    o.upsert_relation("Metformin", "prescribed_by", "Dr. Smith", source="t1", node_types=nt)
    o.upsert_relation("You", "has_condition", "Type 2 Diabetes", source="t2", node_types=nt)
    o.upsert_relation("Metformin", "treats", "Type 2 Diabetes", source="t1", node_types=nt)
    return o

def test_to_cytoscape_shape(tmp_path):
    o = _seed(tmp_path)
    cy = o.to_cytoscape()
    assert {"nodes", "edges"} == set(cy)
    n0 = cy["nodes"][0]["data"]
    assert {"id", "label", "type", "color"} <= set(n0)
    e0 = cy["edges"][0]["data"]
    assert {"source", "target", "label"} <= set(e0)

def test_to_cytoscape_type_filter(tmp_path):
    o = _seed(tmp_path)
    cy = o.to_cytoscape(filter_type="Medication")
    # All non-root nodes must match the filter; the root "You" is always kept so
    # the filtered graph stays connected (You -takes-> Metformin).
    non_root = {n["data"]["type"] for n in cy["nodes"] if not n["data"]["root"]}
    assert non_root <= {"Medication"}
    assert any(n["data"]["root"] for n in cy["nodes"])
    assert cy["edges"], "filtered view should keep the You->Medication edge"

def test_subgraph_for_is_multi_hop_text(tmp_path):
    o = _seed(tmp_path)
    txt = o.subgraph_for("what medication treats my diabetes and who prescribed it")
    assert "Metformin" in txt and "Dr. Smith" in txt and "Type 2 Diabetes" in txt

def test_node_detail(tmp_path):
    o = _seed(tmp_path)
    d = o.node_detail("Metformin")
    assert d["label"] == "Metformin"
    assert any("prescribed_by" in f["predicate"] for f in d["facts"])
    assert d["provenance"]
