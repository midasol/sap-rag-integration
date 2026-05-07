from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from adk_agent import crypto
from adk_agent.sap_gw_connector.config.loader import ServicesConfigLoader
from adk_agent.sap_gw_connector.config.settings import SAPConnectionConfig
from adk_agent.sap_gw_connector.core.auth import build_authenticator
from adk_agent.sap_gw_connector.core.exceptions import (
    SAPAuthenticationError,
    SAPRequestError,
)
from adk_agent.sap_gw_connector.core.sap_client import SAPClient

log = logging.getLogger(__name__)

_YAML = Path(__file__).resolve().parents[1] / "services.yaml"


def _service_path(service_id: str) -> str:
    """Look up service path by id from services.yaml. Raises ValueError if unknown."""
    cfg = ServicesConfigLoader(_YAML).load()
    for s in cfg.services:
        if s.id == service_id:
            return s.path
    raise ValueError(f"unknown service_id: {service_id}")


def _transform(data: dict) -> dict:
    """Normalize OData response: extract `results` and add `count`.

    OData v2: {"d": {"results": [...]}}
    OData v4: {"value": [...]}
    """
    if "d" in data and isinstance(data["d"], dict) and "results" in data["d"]:
        rows = data["d"]["results"]
    elif "value" in data and isinstance(data["value"], list):
        rows = data["value"]
    elif "d" in data and isinstance(data["d"], list):
        rows = data["d"]
    else:
        rows = []
    return {"results": rows, "count": len(rows)}


async def _client_for(creds: dict) -> SAPClient:
    """Build an SAPClient from session credentials (decrypts password)."""
    cfg = SAPConnectionConfig(auth_type=creds["type"])
    auth = build_authenticator(cfg)
    if creds["type"] == "basic":
        auth.set_basic_credentials(creds["user"], crypto.decrypt(creds["password"]))
    return SAPClient(config=cfg, authenticator=auth)


async def sap_query(
    service_id: str,
    entity_set: str,
    filter: str | None = None,
    select: str | None = None,
    top: int | None = None,
    skip: int | None = None,
    tool_context: Any = None,
) -> dict:
    """Query an SAP OData entity set with optional $filter/$select/$top/$skip."""
    creds = (tool_context.state if tool_context else {}).get("sap_credentials")
    if not creds:
        return {
            "success": False,
            "action_required": "sap_login",
            "error": "not_authenticated",
        }

    try:
        path = _service_path(service_id)
    except ValueError as e:
        return {"success": False, "error": str(e)}

    filters = {"$filter": filter} if filter else None
    select_fields = [s.strip() for s in select.split(",")] if select else None

    try:
        client = await _client_for(creds)
        async with client:
            data = await client.query_entity_set(
                service_path=path,
                entity_set=entity_set,
                filters=filters,
                select_fields=select_fields,
                top=top,
                skip=skip,
            )
        return {"success": True, **_transform(data)}
    except SAPAuthenticationError as e:
        return {"success": False, "action_required": "re_authenticate", "error": str(e)}
    except SAPRequestError as e:
        return {"success": False, "error": {"message": str(e)}}
    except Exception as e:
        log.exception("sap_query unexpected")
        return {"success": False, "error": "internal_error", "detail": str(e)}
