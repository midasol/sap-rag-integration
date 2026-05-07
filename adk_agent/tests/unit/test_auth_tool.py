from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from cryptography.fernet import Fernet

from adk_agent import crypto
from adk_agent.tools import auth_tool


@pytest.fixture(autouse=True)
def _crypto_key(monkeypatch):
    monkeypatch.setenv("SAP_CRED_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("SAP_HOST", "sap.example.com")
    crypto.reset()


@pytest.fixture()
def _oauth_env(monkeypatch):
    monkeypatch.setenv("SAP_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("SAP_OAUTH_CLIENT_SECRET", "csec")
    monkeypatch.setenv("SAP_OAUTH_TOKEN_URL", "https://sap.example.com/oauth/token")
    monkeypatch.setenv("SAP_OAUTH_AUTHORIZE_URL", "https://sap.example.com/oauth/authorize")
    monkeypatch.setenv("SAP_OAUTH_REDIRECT_URI", "http://localhost:3000/api/sap/oauth/callback")


class FakeCtx:
    def __init__(self):
        self.state = {}


@pytest.mark.asyncio
async def test_basic_login_success():
    ctx = FakeCtx()
    with patch("adk_agent.tools.auth_tool._verify_basic", AsyncMock(return_value=True)):
        out = await auth_tool.sap_authenticate(
            method="basic", username="admin", password="x", tool_context=ctx
        )
    assert out["success"] is True
    assert ctx.state["sap_credentials"]["type"] == "basic"
    assert ctx.state["sap_credentials"]["user"] == "admin"
    assert ctx.state["sap_credentials"]["password"] != "x"  # encrypted
    # Roundtrip-decrypt to confirm encryption is real
    assert crypto.decrypt(ctx.state["sap_credentials"]["password"]) == "x"


@pytest.mark.asyncio
async def test_basic_login_failure():
    ctx = FakeCtx()
    with patch("adk_agent.tools.auth_tool._verify_basic", AsyncMock(return_value=False)):
        out = await auth_tool.sap_authenticate(
            method="basic", username="admin", password="bad", tool_context=ctx
        )
    assert out["success"] is False
    assert out["error"] == "invalid_credentials"
    assert "sap_credentials" not in ctx.state


@pytest.mark.asyncio
async def test_missing_credentials_returns_action_required():
    ctx = FakeCtx()
    out = await auth_tool.sap_authenticate(method="basic", tool_context=ctx)
    assert out["success"] is False
    assert out["action_required"] == "sap_login"
    assert "sap_credentials" not in ctx.state


@pytest.mark.asyncio
async def test_unknown_method_returns_error():
    ctx = FakeCtx()
    out = await auth_tool.sap_authenticate(method="foo", tool_context=ctx)
    assert out["success"] is False
    assert "unknown method" in out["error"]


# ---------------------------------------------------------------------------
# OAuth tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_oauth_step1_returns_login_url(_oauth_env):
    """Step 1: no code/state → build login URL and store PKCE state."""
    ctx = FakeCtx()
    fake_auth = MagicMock()
    fake_auth.generate_sap_auth_url.return_value = {
        "auth_url": "https://sap.example.com/oauth?response_type=code&state=abc123",
        "state": "abc123",
    }
    with patch("adk_agent.oauth._build_authenticator", return_value=fake_auth):
        out = await auth_tool.sap_authenticate(
            method="oauth", user_id="alice", tool_context=ctx
        )
    assert out["success"] is False
    assert out["action_required"] == "sap_login"
    assert out["login_url"].startswith("https://")
    assert out["oauth_state"] == "abc123"
    assert out["method"] == "oauth"
    assert ctx.state["sap_oauth_pkce"]["state"] == "abc123"
    assert ctx.state["sap_oauth_pkce"]["user_id"] == "alice"


@pytest.mark.asyncio
async def test_oauth_step2_success(_oauth_env):
    """Step 2: code + state → exchange and store credentials."""
    ctx = FakeCtx()
    ctx.state["sap_oauth_pkce"] = {"state": "abc123", "user_id": "alice"}
    mock_exchange = AsyncMock(
        return_value={
            "type": "oauth",
            "access_token": "tok",
            "refresh_token": "rtok",
            "sap_user": "alice@SAP",
            "expires_at": "2026-04-30T00:00:00",
        }
    )
    with patch("adk_agent.oauth.exchange_code", mock_exchange):
        out = await auth_tool.sap_authenticate(
            method="oauth",
            code="c",
            state="abc123",
            tool_context=ctx,
        )
    assert out["success"] is True
    assert out["sap_user"] == "alice@SAP"
    assert out["method"] == "oauth"
    assert ctx.state["sap_credentials"]["access_token"] == "tok"
    assert ctx.state["sap_credentials"]["type"] == "oauth"
    assert "sap_oauth_pkce" not in ctx.state


@pytest.mark.asyncio
async def test_oauth_step2_state_mismatch(_oauth_env):
    """Step 2: state mismatch → reject without storing credentials."""
    ctx = FakeCtx()
    ctx.state["sap_oauth_pkce"] = {"state": "abc123", "user_id": "alice"}
    out = await auth_tool.sap_authenticate(
        method="oauth",
        code="c",
        state="wrong",
        tool_context=ctx,
    )
    assert out["success"] is False
    assert out["error"] == "oauth_state_mismatch"
    assert "sap_credentials" not in ctx.state


@pytest.mark.asyncio
async def test_oauth_missing_env_returns_error(monkeypatch):
    """Missing OAuth env var → config-incomplete error."""
    monkeypatch.delenv("SAP_OAUTH_CLIENT_ID", raising=False)
    ctx = FakeCtx()
    out = await auth_tool.sap_authenticate(method="oauth", tool_context=ctx)
    assert out["success"] is False
    assert "oauth_config_incomplete" in out["error"]
