from pathlib import Path

from adk_agent.sap_gw_connector.config.loader import ServicesConfigLoader

YAML = Path(__file__).resolve().parents[2] / "services.yaml"


def test_services_yaml_parses():
    cfg = ServicesConfigLoader(YAML).load()
    assert cfg.gateway.base_url_pattern.startswith("https://")
    assert len(cfg.services) >= 1, f"expected ≥1 service, got {len(cfg.services)}"
    total_entities = sum(len(s.entities) for s in cfg.services)
    assert total_entities >= 25, f"expected ≥25 entities total, got {total_entities}"


def test_each_service_has_entities():
    cfg = ServicesConfigLoader(YAML).load()
    bad = [s.id for s in cfg.services if not s.entities]
    assert not bad, f"services without entities: {bad}"
