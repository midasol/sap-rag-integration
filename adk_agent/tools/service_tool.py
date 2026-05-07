"""Tool for listing SAP OData services from services.yaml configuration."""

from __future__ import annotations

from pathlib import Path

from adk_agent.sap_gw_connector.config.loader import ServicesConfigLoader

_YAML = Path(__file__).resolve().parents[1] / "services.yaml"


def sap_list_services() -> dict:
    """List all configured SAP OData services and their entities.

    Returns:
        dict: {"services": [{"id", "name", "path", "version", "entities": [{"name", "key_field", "description"}]}]}
    """
    cfg = ServicesConfigLoader(_YAML).load()
    return {
        "services": [
            {
                "id": s.id,
                "name": s.name,
                "path": s.path,
                "version": s.version,
                "entities": [
                    {"name": e.name, "key_field": e.key_field, "description": e.description}
                    for e in s.entities
                ],
            }
            for s in cfg.services
        ]
    }
