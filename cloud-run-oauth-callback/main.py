"""SAP OAuth callback proxy for Mode B (Agent Engine standalone).

When the user authenticates against SAP, SAP redirects to this service's
`/callback` endpoint with `code` and `state` query parameters. We persist
the pair into Secret Manager under `sap-oauth-pending-<state-prefix>` so
the agent can pick it up on its next turn (the `state` value is what ties
the redirect back to the original PKCE round in
`adk_agent/tools/auth_tool.py:120-124`).

This service is required because Vertex AI Agent Engine doesn't expose
arbitrary HTTP endpoints — it only exposes the agent's `query` API. There
is no place on the agent itself for SAP to redirect to.

For Mode A (Cloud Run × 2), the Next.js route at
`src/app/api/sap/oauth/callback/route.ts` plays the same role and this
service is unused.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone

from flask import Flask, request
from google.api_core.exceptions import AlreadyExists, NotFound
from google.cloud import secretmanager
from markupsafe import escape

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT")
if not PROJECT_ID:
    raise RuntimeError("GOOGLE_CLOUD_PROJECT environment variable is required")

PENDING_SECRET_PREFIX = os.environ.get("PENDING_SECRET_PREFIX", "sap-oauth-pending")

app = Flask(__name__)


def _sm_client() -> secretmanager.SecretManagerServiceClient:
    return secretmanager.SecretManagerServiceClient()


def _sanitize_state_for_secret_id(state: str) -> str:
    """Build a Secret Manager-safe ID from the state's first 16 chars."""
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", state[:16])
    return f"{PENDING_SECRET_PREFIX}-{safe}"


def _ensure_secret(client, secret_id: str) -> str:
    parent = f"projects/{PROJECT_ID}"
    secret_path = f"{parent}/secrets/{secret_id}"
    try:
        client.get_secret(request={"name": secret_path})
    except NotFound:
        try:
            client.create_secret(
                request={
                    "parent": parent,
                    "secret_id": secret_id,
                    "secret": {"replication": {"automatic": {}}},
                }
            )
            log.info("Created secret %s", secret_id)
        except AlreadyExists:
            pass
    return secret_path


@app.route("/callback")
def oauth_callback():
    code = request.args.get("code")
    state = request.args.get("state")
    error = request.args.get("error")

    if error:
        log.warning("OAuth error: %s", error)
        return _error_page(f"SAP login failed: {escape(error)}"), 400

    if not code or not state:
        log.warning("Missing code or state")
        return _error_page("Invalid callback: missing code or state"), 400

    try:
        client = _sm_client()
        secret_id = _sanitize_state_for_secret_id(state)
        secret_path = _ensure_secret(client, secret_id)

        payload = {
            "code": code,
            "state": state,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        client.add_secret_version(
            request={
                "parent": secret_path,
                "payload": {"data": json.dumps(payload).encode("utf-8")},
            }
        )
        log.info("Stored pending OAuth code: secret=%s state=%.8s...", secret_id, state)
        return _success_page(secret_id), 200
    except Exception:
        log.exception("Failed to store OAuth code")
        return _error_page("Internal error. Please try again."), 500


@app.route("/health")
def health():
    return {"status": "ok"}


def _success_page(secret_id: str) -> str:
    safe = escape(secret_id)
    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>SAP Login Complete</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         display: flex; justify-content: center; align-items: center;
         min-height: 100vh; background: #f5f5f5; margin: 0; }}
  .card {{ background: #fff; border-radius: 12px; padding: 40px;
          box-shadow: 0 2px 16px rgba(0,0,0,0.1); text-align: center;
          max-width: 420px; }}
  .check {{ width: 64px; height: 64px; background: #e8f5e9; border-radius: 50%;
           display: flex; align-items: center; justify-content: center;
           margin: 0 auto 20px; font-size: 32px; color: #2e7d32; }}
  h2 {{ color: #1a73e8; margin-bottom: 12px; font-size: 22px; }}
  p {{ color: #666; line-height: 1.6; font-size: 15px; }}
  code {{ background: #f1f3f4; padding: 2px 6px; border-radius: 4px; font-size: 12px; }}
</style></head>
<body><div class="card">
  <div class="check">&#10003;</div>
  <h2>SAP Login Complete</h2>
  <p>You can close this tab and return to the chat.<br>
     The agent will pick up your login on the next message.</p>
  <p style="margin-top:16px;font-size:12px;color:#999;">Reference: <code>{safe}</code></p>
</div></body></html>"""


def _error_page(message: str) -> str:
    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>SAP Login Error</title>
<style>
  body {{ font-family: -apple-system, sans-serif; display: flex;
         justify-content: center; align-items: center;
         min-height: 100vh; background: #f5f5f5; margin: 0; }}
  .card {{ background: #fff; border-radius: 12px; padding: 40px;
          box-shadow: 0 2px 16px rgba(0,0,0,0.1); text-align: center;
          max-width: 420px; }}
  .icon {{ width: 64px; height: 64px; background: #fce4ec; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          margin: 0 auto 20px; font-size: 32px; color: #c62828; }}
  h2 {{ color: #c62828; margin-bottom: 12px; }}
  p {{ color: #666; line-height: 1.6; }}
</style></head>
<body><div class="card">
  <div class="icon">&#10007;</div>
  <h2>Login Error</h2>
  <p>{escape(message)}</p>
</div></body></html>"""


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
