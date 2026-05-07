"""OAuth 2.0 PKCE helpers — thin wrappers over the vendored SAPAuthenticator.

Adapted from sap-gemini-enterprise/sap_agent/agent.py (sap_authenticate body).
The full reference uses Cloud Run callback + Secret Manager polling; here the
callback is proxied by the Next.js layer (/api/sap/oauth/callback), so we only
need Step 1 (build login URL) and Step 2 (exchange code for token).
"""
from __future__ import annotations

import logging
import os
from typing import Any

log = logging.getLogger(__name__)

REQUIRED_OAUTH_ENV = [
    "SAP_OAUTH_CLIENT_ID",
    "SAP_OAUTH_CLIENT_SECRET",
    "SAP_OAUTH_TOKEN_URL",
    "SAP_OAUTH_AUTHORIZE_URL",
    "SAP_OAUTH_REDIRECT_URI",
]


def _missing_oauth_env() -> list[str]:
    return [v for v in REQUIRED_OAUTH_ENV if not os.getenv(v)]


def _build_authenticator() -> Any:
    """Construct an SAPAuthenticator configured for OAuth Authorization Code."""
    from adk_agent.sap_gw_connector.config.settings import SAPConnectionConfig
    from adk_agent.sap_gw_connector.core.auth import SAPAuthenticator

    cfg = SAPConnectionConfig(auth_type="sap_oauth")
    return SAPAuthenticator(cfg)


def build_login_url(user_id: str) -> dict:
    """Step 1: Generate SAP OAuth authorization URL with PKCE.

    Returns {auth_url, state} as produced by SAPAuthenticator.generate_sap_auth_url.
    Raises RuntimeError if required env is missing.
    """
    missing = _missing_oauth_env()
    if missing:
        raise RuntimeError(f"OAuth config incomplete: missing {missing}")
    auth = _build_authenticator()
    return auth.generate_sap_auth_url(user_id)


async def exchange_code(code: str, state: str, user_id: str) -> dict:
    """Step 2: Exchange authorization code for SAP access token.

    Returns a dict suitable for storing in tool_context.state["sap_credentials"]:
        {type: "oauth", access_token, refresh_token, sap_user, expires_at}
    Raises on token-endpoint failure.
    """
    auth = _build_authenticator()
    token = await auth.exchange_authorization_code(code, state, user_id=user_id)
    # SAPUserToken fields: access_token, refresh_token, token_type, scope, sap_user
    # expires_at is inherited from AuthToken
    return {
        "type": "oauth",
        "access_token": token.access_token,
        "refresh_token": token.refresh_token,
        "sap_user": token.sap_user,
        "expires_at": token.expires_at.isoformat() if token.expires_at else None,
    }
