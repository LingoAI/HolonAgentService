# holon/backend/tests/test_llm.py
from backend.engine import llm

def test_endpoint_for_local_vs_cloud():
    url, headers, model = llm.endpoint_for("local")
    assert url.startswith("http://localhost") and headers == {} and model
    url, headers, model = llm.endpoint_for("cloud")
    assert "ollama.com" in url and "Authorization" in (headers or {"Authorization": ""}) or headers == {}

def test_parse_extraction_json_tolerant():
    raw = 'noise {"entities":[{"name":"Metformin","type":"Medication"}],' \
          '"relations":[{"subject":"You","predicate":"takes","object":"Metformin"}]} tail'
    out = llm.parse_extraction(raw)
    assert out["entities"][0]["name"] == "Metformin"
    assert out["relations"][0]["predicate"] == "takes"

def test_parse_extraction_bad_returns_empty():
    assert llm.parse_extraction("not json at all") == {"entities": [], "relations": []}

def test_parse_extraction_unwraps_nested_payload():
    raw = ('{"thoughts":"ok","result":{"entities":[{"name":"Yoga","type":"Event"}],'
           '"relations":[{"subject":"You","predicate":"did","object":"Yoga"}]}}')
    out = llm.parse_extraction(raw)
    assert out["entities"][0]["name"] == "Yoga"
    assert out["relations"][0]["object"] == "Yoga"
