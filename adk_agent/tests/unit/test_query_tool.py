from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from cryptography.fernet import Fernet

from adk_agent import crypto
from adk_agent.sap_gw_connector.core.exceptions import (
    SAPAuthenticationError,
    SAPRequestError,
)
from adk_agent.tools import query_tool


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SAP_CRED_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("SAP_HOST", "sap.example.com")
    crypto.reset()


class Ctx:
    def __init__(self, creds=None):
        self.state = {"sap_credentials": creds} if creds else {}


def _fake_client_with(method_name: str, **kwargs):
    """Build a MagicMock that satisfies async-context-manager + the named coroutine method."""
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    setattr(client, method_name, AsyncMock(**kwargs))
    return client


@pytest.mark.asyncio
async def test_query_no_creds_returns_action_required():
    out = await query_tool.sap_query("API_PRODUCT_SRV", "A_Product", tool_context=Ctx())
    assert out["success"] is False
    assert out["action_required"] == "sap_login"


@pytest.mark.asyncio
async def test_query_unknown_service_returns_error():
    enc_pw = crypto.encrypt("p")
    creds = {"type": "basic", "user": "u", "password": enc_pw}
    out = await query_tool.sap_query("DOES_NOT_EXIST", "X", tool_context=Ctx(creds))
    assert out["success"] is False
    assert "unknown service_id" in out["error"]


@pytest.mark.asyncio
async def test_query_happy_v2_envelope():
    enc_pw = crypto.encrypt("p")
    creds = {"type": "basic", "user": "u", "password": enc_pw}
    fake = _fake_client_with(
        "query_entity_set",
        return_value={"d": {"results": [{"Material": "P-001"}, {"Material": "P-002"}]}},
    )
    with patch("adk_agent.tools.query_tool._client_for", AsyncMock(return_value=fake)):
        out = await query_tool.sap_query(
            "API_PRODUCT_SRV", "A_Product", filter="Material eq 'P-001'", tool_context=Ctx(creds)
        )
    assert out["success"] is True
    assert out["count"] == 2
    assert out["results"][0]["Material"] == "P-001"
    # Confirm filter was forwarded as filters={"$filter": ...}
    call = fake.query_entity_set.call_args
    assert call.kwargs["filters"] == {"$filter": "Material eq 'P-001'"}
    assert call.kwargs["entity_set"] == "A_Product"


@pytest.mark.asyncio
async def test_query_happy_v4_envelope():
    enc_pw = crypto.encrypt("p")
    creds = {"type": "basic", "user": "u", "password": enc_pw}
    fake = _fake_client_with(
        "query_entity_set",
        return_value={"value": [{"k": 1}]},
    )
    with patch("adk_agent.tools.query_tool._client_for", AsyncMock(return_value=fake)):
        out = await query_tool.sap_query("API_PRODUCT_SRV", "A_Product", tool_context=Ctx(creds))
    assert out["success"] is True
    assert out["count"] == 1


@pytest.mark.asyncio
async def test_query_select_split_into_list():
    enc_pw = crypto.encrypt("p")
    creds = {"type": "basic", "user": "u", "password": enc_pw}
    fake = _fake_client_with("query_entity_set", return_value={"value": []})
    with patch("adk_agent.tools.query_tool._client_for", AsyncMock(return_value=fake)):
        await query_tool.sap_query(
            "API_PRODUCT_SRV", "A_Product", select="Material, ProductType", tool_context=Ctx(creds)
        )
    call = fake.query_entity_set.call_args
    assert call.kwargs["select_fields"] == ["Material", "ProductType"]


@pytest.mark.asyncio
async def test_query_auth_error_returns_reauth():
    enc_pw = crypto.encrypt("p")
    creds = {"type": "basic", "user": "u", "password": enc_pw}
    fake = _fake_client_with("query_entity_set", side_effect=SAPAuthenticationError("401"))
    with patch("adk_agent.tools.query_tool._client_for", AsyncMock(return_value=fake)):
        out = await query_tool.sap_query("API_PRODUCT_SRV", "A_Product", tool_context=Ctx(creds))
    assert out["success"] is False
    assert out["action_required"] == "re_authenticate"


@pytest.mark.asyncio
async def test_query_request_error_returns_structured_error():
    enc_pw = crypto.encrypt("p")
    creds = {"type": "basic", "user": "u", "password": enc_pw}
    fake = _fake_client_with("query_entity_set", side_effect=SAPRequestError("bad request"))
    with patch("adk_agent.tools.query_tool._client_for", AsyncMock(return_value=fake)):
        out = await query_tool.sap_query("API_PRODUCT_SRV", "A_Product", tool_context=Ctx(creds))
    assert out["success"] is False
    assert "message" in out["error"]
