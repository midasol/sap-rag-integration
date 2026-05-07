"""Root LlmAgent: 5 tools — search_documents, sap_authenticate, sap_list_services, sap_query, sap_get_entity.

Optionally augmented with a Pub/Sub MCP toolset (see ``mcp_pubsub.py``)
when ``.mcp.json`` is configured. The Pub/Sub block is added to ``tools=``
and a ``before_tool_callback`` enforces the per-resource allowlists.
"""
from __future__ import annotations

import os
from functools import cached_property

from google.adk.agents import Agent
from google.adk.models import Gemini
from google.genai import Client, types

from adk_agent.mcp_pubsub import setup_pubsub_mcp
from adk_agent.tools.auth_tool import sap_authenticate
from adk_agent.tools.entity_tool import sap_get_entity
from adk_agent.tools.query_tool import sap_query
from adk_agent.tools.rag_tool import search_documents
from adk_agent.tools.service_tool import sap_list_services

MODEL_NAME = os.getenv("SAP_AGENT_MODEL", "gemini-3.1-pro-preview")


# Workaround: Agent Engine reserves GOOGLE_CLOUD_LOCATION and pins it to the
# deployment region, but Gemini 3 models are only served from the *global*
# endpoint. Subclass Gemini to force `location="global"` on the api_client.
# Ref: https://github.com/google/adk-python/issues/3628#issuecomment-3595215761
class GlobalGemini(Gemini):
    @cached_property
    def api_client(self) -> Client:
        project = os.getenv("GOOGLE_CLOUD_PROJECT") or os.getenv("PROJECT_ID", "")
        return Client(
            project=project,
            location="global",
            http_options=types.HttpOptions(
                headers=self._tracking_headers(),
                retry_options=self.retry_options,
            ),
        )


MODEL = GlobalGemini(model=MODEL_NAME)

_BASE_INSTRUCTION = """You are a unified enterprise assistant with the following data sources:

1. **Documents** (search_documents): semantic search over the multimodal RAG corpus.
2. **SAP** (sap_*): live OData queries to SAP Gateway.

Routing:
- General knowledge questions about uploaded documents → search_documents.
- Structured business data (products, sales orders, plants, materials, etc.) → sap_query / sap_get_entity.
- If the user asks for SAP data and no session exists, authenticate first (see Auth).
- Use sap_list_services when the user asks "what data is available".
- For mixed questions, call both tools and synthesize.

Auth (inline, no popups — designed for Gemini Enterprise):
- Default authentication is Basic (SAP username + password) collected directly in this chat.
- When SAP credentials are not yet set and the user asks for SAP data, ask them
  in chat: "Please provide your SAP username and password to continue." Do NOT
  open external windows, do NOT return login URLs unless OAuth is explicitly
  configured by the operator.
- Once the user provides them in their next message, call
  `sap_authenticate(method="basic", username=<user>, password=<pw>)`.
- If a tool returns action_required="sap_login" or "re_authenticate", ask the
  user to re-enter their SAP username and password in chat, then call
  `sap_authenticate` again.
- OAuth fallback: only if the operator has configured OAuth (the tool will
  return method="oauth" with a login_url). In that case, present the URL as a
  plain clickable link and instruct the user to open it in the same browser
  tab — never imply a popup will appear.

Security (CRITICAL):
- NEVER echo the user's password, OAuth code, or access token back in any
  response. Confirm authentication with a short message like
  "Authenticated as <username>." — nothing more.
- NEVER include credentials in tool-call summaries or thinking shown to the
  user.

Output format:
- Use markdown tables for SAP entity lists.
- Cite document sources with their `source` field for RAG answers.
- Keep responses concise; suggest follow-up queries when helpful.
"""

_BASE_TOOLS = [
    search_documents,
    sap_authenticate,
    sap_list_services,
    sap_query,
    sap_get_entity,
]

_pubsub = setup_pubsub_mcp()

if _pubsub is not None:
    INSTRUCTION = _BASE_INSTRUCTION + _pubsub.instruction_block
    _TOOLS = _BASE_TOOLS + [_pubsub.toolset]
    _BEFORE_TOOL_CALLBACK = _pubsub.gate
else:
    INSTRUCTION = _BASE_INSTRUCTION
    _TOOLS = _BASE_TOOLS
    _BEFORE_TOOL_CALLBACK = None


root_agent = Agent(
    model=MODEL,
    name="sapphire26_agent",
    description="Unified RAG + SAP OData agent (with optional Pub/Sub MCP)",
    instruction=INSTRUCTION,
    tools=_TOOLS,
    before_tool_callback=_BEFORE_TOOL_CALLBACK,
)
