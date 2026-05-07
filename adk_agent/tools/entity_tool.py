from __future__ import annotations

import logging
from typing import Any

from adk_agent.sap_gw_connector.core.exceptions import (
    SAPAuthenticationError,
    SAPRequestError,
)
from adk_agent.tools.query_tool import _client_for, _service_path

log = logging.getLogger(__name__)


async def sap_get_entity(
    service_id: str,
    entity_set: str,
    key: str,
    tool_context: Any = None,
) -> dict:
    """Retrieve a single SAP OData entity by key."""
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

    try:
        client = await _client_for(creds)
        async with client:
            entity = await client.get_entity(
                service_path=path, entity_set=entity_set, entity_key=key
            )
        return {"success": True, "entity": entity}
    except SAPAuthenticationError as e:
        return {"success": False, "action_required": "re_authenticate", "error": str(e)}
    except SAPRequestError as e:
        return {"success": False, "error": {"message": str(e)}}
    except Exception as e:
        log.exception("sap_get_entity unexpected")
        return {"success": False, "error": "internal_error", "detail": str(e)}
