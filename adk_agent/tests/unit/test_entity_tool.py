from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from cryptography.fernet import Fernet

from adk_agent import crypto
from adk_agent.sap_gw_connector.core.exceptions import (
    SAPAuthenticationError,
    SAPRequestError,
)
from adk_agent.tools import entity_tool


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("SAP_CRED_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("SAP_HOST", "sap.example.com")
    crypto.reset()


class Ctx:
    def __init__(self, creds=None):
        self.state = {"sap_credentials": creds} if creds else {}


def _fake_client_with(method_name: str, **kwargs):
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    setattr(client, method_name, AsyncMock(**kwargs))
    return client


@pytest.mark.asyncio
async def test_get_entity_no_creds():
    out = await entity_tool.sap_get_entity(
        "API_PRODUCT_SRV", "A_Product", "P-001", tool_context=Ctx()
    )
    assert out["success"] is False
    assert out["action_required"] == "sap_login"


@pytest.mark.asyncio
async def test_get_entity_unknown_service():
    creds = {"type": "basic", "user": "u", "password": crypto.encrypt("p")}
    out = await entity_tool.sap_get_entity(
        "DOES_NOT_EXIST", "X", "K", tool_context=Ctx(creds)
    )
    assert out["success"] is False
    assert "unknown service_id" in out["error"]


@pytest.mark.asyncio
async def test_get_entity_happy():
    creds = {"type": "basic", "user": "u", "password": crypto.encrypt("p")}
    fake = _fake_client_with("get_entity", return_value={"Material": "P-001"})
    with patch("adk_agent.tools.entity_tool._client_for", AsyncMock(return_value=fake)):
        out = await entity_tool.sap_get_entity(
            "API_PRODUCT_SRV", "A_Product", "P-001", tool_context=Ctx(creds)
        )
    assert out["success"] is True
    assert out["entity"]["Material"] == "P-001"
    call = fake.get_entity.call_args
    assert call.kwargs["entity_key"] == "P-001"
    assert call.kwargs["entity_set"] == "A_Product"


@pytest.mark.asyncio
async def test_get_entity_auth_error_returns_reauth():
    creds = {"type": "basic", "user": "u", "password": crypto.encrypt("p")}
    fake = _fake_client_with("get_entity", side_effect=SAPAuthenticationError("401"))
    with patch("adk_agent.tools.entity_tool._client_for", AsyncMock(return_value=fake)):
        out = await entity_tool.sap_get_entity(
            "API_PRODUCT_SRV", "A_Product", "P-001", tool_context=Ctx(creds)
        )
    assert out["action_required"] == "re_authenticate"


@pytest.mark.asyncio
async def test_get_entity_request_error():
    creds = {"type": "basic", "user": "u", "password": crypto.encrypt("p")}
    fake = _fake_client_with("get_entity", side_effect=SAPRequestError("not found"))
    with patch("adk_agent.tools.entity_tool._client_for", AsyncMock(return_value=fake)):
        out = await entity_tool.sap_get_entity(
            "API_PRODUCT_SRV", "A_Product", "P-999", tool_context=Ctx(creds)
        )
    assert out["success"] is False
    assert "message" in out["error"]
