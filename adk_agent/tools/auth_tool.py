from __future__ import annotations

import logging
import os
from typing import Any

from adk_agent import crypto
from adk_agent.sap_gw_connector.config.settings import SAPConnectionConfig
from adk_agent.sap_gw_connector.core.auth import build_authenticator
from adk_agent.sap_gw_connector.core.sap_client import SAPClient

log = logging.getLogger(__name__)


async def _verify_basic(user: str, pw: str) -> bool:
    """Verify Basic credentials by hitting the SAP service catalog."""
    try:
        cfg = SAPConnectionConfig(auth_type="basic")
        auth = build_authenticator(cfg)
        auth.set_basic_credentials(user, pw)
        async with SAPClient(config=cfg, authenticator=auth) as client:
            await client.list_services()
        return True
    except Exception:
        log.exception("basic verify failed")
        return False


async def sap_authenticate(
    method: str | None = None,
    username: str | None = None,
    password: str | None = None,
    code: str | None = None,
    state: str | None = None,
    user_id: str | None = None,
    tool_context: Any = None,
) -> dict:
    """Authenticate against SAP. method='basic' (default) or 'oauth'.

    For 'basic': requires username + password. On success, stores encrypted
    credentials in tool_context.state['sap_credentials'].

    For 'oauth' Step 1 (no code/state): builds SAP login URL with PKCE,
    stores {state, user_id} in tool_context.state['sap_oauth_pkce'], and
    returns {success: False, action_required: 'sap_login', login_url, oauth_state}.

    For 'oauth' Step 2 (code + state present): verifies state against stored
    PKCE state, exchanges code for token via SAP OAuth endpoint, stores
    credentials in tool_context.state['sap_credentials'], and clears PKCE state.
    Callback delivery is handled by the Next.js /api/sap/oauth/callback route.
    """
    if method is None:
        method = os.getenv("SAP_AUTH_TYPE", "basic")
    # Normalize aliases — `sap_oauth` is the connector-config name for OAuth.
    if method == "sap_oauth":
        method = "oauth"

    if method == "basic":
        if not username or not password:
            return {
                "success": False,
                "action_required": "sap_login",
                "error": "username and password required for basic auth",
            }
        ok = await _verify_basic(username, password)
        if not ok:
            return {"success": False, "error": "invalid_credentials"}
        if tool_context is not None:
            tool_context.state["sap_credentials"] = {
                "type": "basic",
                "user": username,
                "password": crypto.encrypt(password),
            }
        return {"success": True, "sap_user": username, "method": "basic"}

    if method == "oauth":
        from adk_agent.oauth import _missing_oauth_env, build_login_url, exchange_code

        missing = _missing_oauth_env()
        if missing:
            return {
                "success": False,
                "error": f"oauth_config_incomplete: missing {missing}",
            }

        # Step 2: code + state present → verify state and exchange code
        if code and state:
            stored = (
                tool_context.state.get("sap_oauth_pkce") if tool_context else None
            ) or {}
            if stored.get("state") and stored["state"] != state:
                return {"success": False, "error": "oauth_state_mismatch"}
            uid = user_id or stored.get("user_id") or "default_user"
            try:
                creds = await exchange_code(code, state, uid)
            except Exception as e:
                log.exception("oauth exchange failed")
                return {"success": False, "error": f"oauth_exchange_failed: {e}"}
            if tool_context is not None:
                tool_context.state["sap_credentials"] = creds
                # Clear PKCE state to prevent replay
                tool_context.state.pop("sap_oauth_pkce", None)
            return {
                "success": True,
                "sap_user": creds.get("sap_user") or uid,
                "method": "oauth",
            }

        # Step 1: no code/state → build login URL
        uid = user_id or "default_user"
        try:
            info = build_login_url(uid)
        except Exception as e:
            log.exception("oauth url build failed")
            return {"success": False, "error": f"oauth_url_build_failed: {e}"}
        if tool_context is not None:
            tool_context.state["sap_oauth_pkce"] = {
                "state": info["state"],
                "user_id": uid,
            }
        return {
            "success": False,
            "action_required": "sap_login",
            "login_url": info["auth_url"],
            "oauth_state": info["state"],
            "method": "oauth",
        }

    return {"success": False, "error": f"unknown method: {method}"}
