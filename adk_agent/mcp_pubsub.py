"""Runtime Pub/Sub MCP integration for the sapphire26 ADK agent.

Mirrors the design used in the sibling Next.js project
(`src/lib/mcp-pubsub.ts`):

* Single source of truth — config is read from `.mcp.json` at the project root.
  Same file Claude Code uses for its own MCP registration; the runtime ADK
  agent picks up the same allowlists.
* Deny-by-default — if `allowedTools` / `allowedTopics` /
  `allowedSubscriptions` is missing or empty, NOTHING in that category is
  permitted. The user must opt resources in explicitly.
* Bearer token freshness — uses `MCPToolset.header_provider`, which is
  invoked per HTTP exchange, so an expired ADC token is refreshed without
  rebuilding the toolset.
* Resource gate — implemented via the LlmAgent's `before_tool_callback`
  hook, since ADK's built-in `tool_filter` only filters at tool-selection
  time, not call-time argument validation.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

import google.auth
from google.auth.credentials import Credentials
from google.auth.transport.requests import Request as AuthRequest
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams
from google.adk.tools.tool_context import ToolContext

logger = logging.getLogger(__name__)

PUBSUB_OAUTH_SCOPE = "https://www.googleapis.com/auth/pubsub"
TOPIC_ARG_KEYS: tuple[str, ...] = ("topicId", "topic", "topicName", "topic_name")
SUBSCRIPTION_ARG_KEYS: tuple[str, ...] = (
    "subscriptionId",
    "subscription",
    "subscriptionName",
    "subscription_name",
)

def _default_mcp_config_path() -> Path:
    """Resolve `.mcp.json` location across local dev and Agent Engine.

    Priority:
    1. `MCP_CONFIG_PATH` env var — set by the Agent Engine deploy script so
       the bundled file is found regardless of the runtime cwd.
    2. `<project root>/.mcp.json` — derived from this module's location
       (parent of the `adk_agent/` package). Works in `uv run`, Cloud Run,
       and any deployment that ships the file alongside the package.
    3. `Path.cwd() / ".mcp.json"` — legacy fallback for callers that rely
       on the historical behaviour.
    """
    env_override = os.environ.get("MCP_CONFIG_PATH")
    if env_override:
        return Path(env_override)
    pkg_root = Path(__file__).resolve().parent.parent
    candidate = pkg_root / ".mcp.json"
    if candidate.exists():
        return candidate
    return Path.cwd() / ".mcp.json"


# Project-root .mcp.json path. Same convention as Claude Code uses.
MCP_CONFIG_PATH = _default_mcp_config_path()


@dataclass(frozen=True)
class PubsubMCPConfig:
    """Parsed `mcpServers.pubsub` section of `.mcp.json`."""

    url: str
    headers: Dict[str, str]
    project_id: str
    allowed_tools: tuple[str, ...] = field(default_factory=tuple)
    allowed_topics: tuple[str, ...] = field(default_factory=tuple)
    allowed_subscriptions: tuple[str, ...] = field(default_factory=tuple)


def load_pubsub_mcp_config(
    path: Path = MCP_CONFIG_PATH,
) -> Optional[PubsubMCPConfig]:
    """Read and validate `.mcp.json`.

    Returns `None` if the file is missing, malformed, or doesn't carry a
    well-formed `mcpServers.pubsub` block. Allowlist fields default to the
    empty tuple (deny-by-default — same policy as the TS port).
    """
    try:
        if not path.exists():
            return None
        raw = path.read_text(encoding="utf-8")
        parsed = json.loads(raw)
    except (OSError, ValueError) as exc:
        logger.warning("mcp.pubsub.config_read_failed path=%s err=%s", path, exc)
        return None

    server = (parsed.get("mcpServers") or {}).get("pubsub")
    if not isinstance(server, dict):
        return None
    if server.get("type") != "http" or not isinstance(server.get("url"), str):
        return None

    headers = server.get("headers") or {}
    if not isinstance(headers, dict):
        return None
    project_id = headers.get("x-goog-user-project")
    if not isinstance(project_id, str) or not project_id:
        return None

    return PubsubMCPConfig(
        url=server["url"],
        headers={k: str(v) for k, v in headers.items()},
        project_id=project_id,
        allowed_tools=_as_str_tuple(server.get("allowedTools")),
        allowed_topics=_as_str_tuple(server.get("allowedTopics")),
        allowed_subscriptions=_as_str_tuple(server.get("allowedSubscriptions")),
    )


def _as_str_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str))


# ---------------------------------------------------------------------------
# Toolset construction
# ---------------------------------------------------------------------------


def build_pubsub_toolset(config: PubsubMCPConfig) -> Optional[McpToolset]:
    """Build an ADK MCPToolset for the Pub/Sub MCP server.

    * `tool_filter=allowed_tools` enforces tool-name allowlist at the SDK
      layer (deny-by-default — empty list means no tools exposed).
    * `header_provider` is called per HTTP exchange and returns headers with
      a fresh Bearer token so we don't have to rebuild the toolset on
      expiry.
    * Returns `None` if Application Default Credentials cannot be obtained;
      the caller should treat null as "Pub/Sub support disabled".
    """
    try:
        credentials, _ = google.auth.default(scopes=[PUBSUB_OAUTH_SCOPE])
    except Exception as exc:
        logger.warning("mcp.pubsub.adc_unavailable err=%s", exc)
        return None

    base_headers = dict(config.headers)

    def header_provider(_ctx: Any) -> Dict[str, str]:
        # Refresh token if it's about to expire / never fetched.
        if not credentials.valid:
            try:
                credentials.refresh(AuthRequest())
            except Exception as exc:
                logger.warning("mcp.pubsub.token_refresh_failed err=%s", exc)
                # Return base headers without Authorization — the MCP server
                # will reject and the LLM gets an upstream error to surface.
                return dict(base_headers)
        return {
            **base_headers,
            "Authorization": f"Bearer {credentials.token}",
        }

    logger.info(
        "mcp.pubsub.toolset_built project_id=%s allowed_tools=%s",
        config.project_id,
        config.allowed_tools,
    )

    return McpToolset(
        connection_params=StreamableHTTPConnectionParams(
            url=config.url,
            headers=base_headers,  # static fallback; header_provider takes precedence
        ),
        tool_filter=list(config.allowed_tools),
        header_provider=header_provider,
    )


# ---------------------------------------------------------------------------
# Resource gate (call-time arg validation)
# ---------------------------------------------------------------------------


def make_pubsub_resource_gate(config: PubsubMCPConfig):
    """Build a `before_tool_callback` for the LlmAgent.

    The callback inspects every tool call and, if the args carry a
    `topicId`/`subscriptionId` argument that doesn't resolve to a name on
    the relevant allowlist, short-circuits the call with an MCP-style error
    response. Calls that don't carry resource args (e.g. `list_topics`)
    pass through unchanged. Calls to non-Pub/Sub tools are also
    unaffected — the gate is purely arg-key driven.
    """

    def gate(
        *,
        tool: BaseTool,
        args: Dict[str, Any],
        tool_context: ToolContext,
    ) -> Optional[Dict[str, Any]]:
        violation = _check_resource_allowed(args or {}, config)
        if violation is None:
            return None

        logger.warning(
            "mcp.pubsub.resource_denied tool=%s reason=%s",
            getattr(tool, "name", "?"),
            violation,
        )
        return {
            "isError": True,
            "content": [
                {"type": "text", "text": f"Access denied: {violation}"}
            ],
        }

    return gate


def _check_resource_allowed(
    args: Dict[str, Any], config: PubsubMCPConfig
) -> Optional[str]:
    """Returns a violation string, or None if the call is allowed."""
    for key in TOPIC_ARG_KEYS:
        value = args.get(key)
        if not isinstance(value, str):
            continue
        bare = _extract_bare_name(value, "topics")
        if bare not in config.allowed_topics:
            allowed = (
                "(none)"
                if not config.allowed_topics
                else ", ".join(config.allowed_topics)
            )
            return f"topic '{bare}' is not in allowedTopics {allowed}"

    for key in SUBSCRIPTION_ARG_KEYS:
        value = args.get(key)
        if not isinstance(value, str):
            continue
        bare = _extract_bare_name(value, "subscriptions")
        if bare not in config.allowed_subscriptions:
            allowed = (
                "(none)"
                if not config.allowed_subscriptions
                else ", ".join(config.allowed_subscriptions)
            )
            return f"subscription '{bare}' is not in allowedSubscriptions {allowed}"

    return None


def _extract_bare_name(value: str, kind: str) -> str:
    """Reduce `projects/X/topics/Y` (or `topics/Y`, or bare `Y`) to `Y`."""
    marker_with_slash = f"/{kind}/"
    idx = value.find(marker_with_slash)
    if idx >= 0:
        return value[idx + len(marker_with_slash) :]
    prefix = f"{kind}/"
    if value.startswith(prefix):
        return value[len(prefix) :]
    return value


# ---------------------------------------------------------------------------
# System-prompt augmentation (mirror of orchestrator.ts buildSystemInstruction)
# ---------------------------------------------------------------------------


def build_pubsub_instruction_block(config: PubsubMCPConfig) -> str:
    """Returns a markdown block to append to the agent's system instruction
    so the LLM knows what's allowed and the exact arg shapes."""
    tools = ", ".join(f"`{t}`" for t in config.allowed_tools) or "(none — Pub/Sub disabled)"
    topics = ", ".join(f"`{t}`" for t in config.allowed_topics) or "(none)"
    subs = ", ".join(f"`{s}`" for s in config.allowed_subscriptions) or "(none)"
    return f"""

3. **Google Cloud Pub/Sub** — Live messaging via MCP tools.
   - Current GCP project: **`{config.project_id}`**.
   - **Allowlisted tools you may call**: {tools}.
   - **Allowlisted topics you may publish to / inspect**: {topics}.
   - **Allowlisted subscriptions you may inspect**: {subs}.
   - **Argument format** (verified against the live server):
     - All tools take `projectId` as a bare project ID, e.g. `"{config.project_id}"` — never a `projects/X` path.
     - Per-resource ops use a SEPARATE `topicId` or `subscriptionId` (bare ID, e.g. `"sapphire-demo"`) alongside `projectId`. Do NOT pass full resource paths like `"projects/X/topics/Y"` for `topicId`.
     - `publish` shape: `{{ projectId, topicId, messages: [{{ data: <base64-encoded string> }}] }}`. Encode the message body as base64 yourself before calling.
   - This MCP server is **management-only** — it does NOT expose `pull`, `acknowledge`, or message-consumption operations. To inspect message contents, instruct the user to run `gcloud pubsub subscriptions pull` separately. Do not promise to pull messages.
   - Do NOT ask the user for the project ID — use `{config.project_id}` automatically.
   - If a request would target a resource outside the allowlists above, explain the restriction to the user instead of attempting the call.
"""


# Convenience export: a single function that returns everything the agent
# module needs in one shot, so agent.py stays clean.


@dataclass(frozen=True)
class PubsubMCPBundle:
    toolset: McpToolset
    instruction_block: str
    config: PubsubMCPConfig
    gate: Any  # before_tool_callback


def setup_pubsub_mcp() -> Optional[PubsubMCPBundle]:
    """Top-level entry: load config, build toolset, build gate, build prompt.
    Returns `None` if Pub/Sub MCP is not available or not configured.
    """
    config = load_pubsub_mcp_config()
    if config is None:
        logger.info("mcp.pubsub.not_configured (no .mcp.json or pubsub block)")
        return None
    toolset = build_pubsub_toolset(config)
    if toolset is None:
        return None
    return PubsubMCPBundle(
        toolset=toolset,
        instruction_block=build_pubsub_instruction_block(config),
        config=config,
        gate=make_pubsub_resource_gate(config),
    )
