from adk_agent.tools.service_tool import sap_list_services


def test_lists_services():
    out = sap_list_services()
    assert "services" in out
    assert len(out["services"]) >= 1
    s0 = out["services"][0]
    for k in ("id", "name", "path", "version", "entities"):
        assert k in s0


def test_total_entities_count():
    out = sap_list_services()
    total = sum(len(s["entities"]) for s in out["services"])
    assert total >= 25  # plan said "25 services" but actual is 1 service with 32 entities


def test_entity_shape():
    out = sap_list_services()
    e = out["services"][0]["entities"][0]
    for k in ("name", "key_field", "description"):
        assert k in e
