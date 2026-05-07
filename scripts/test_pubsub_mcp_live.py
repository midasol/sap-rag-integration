"""Live integration test for the runtime Pub/Sub MCP wiring on ADK.

Exercises the same code path as the LlmAgent (load_pubsub_mcp_config →
build_pubsub_toolset → resource gate) against the real
https://pubsub.googleapis.com/mcp endpoint. Mirrors the sibling Next.js
project's ``scripts/test-pubsub-mcp-live.ts``.

Run:
    cd /Users/judelee/myproject/sap-rag-integration
    uv run python scripts/test_pubsub_mcp_live.py

Note: The Google Pub/Sub MCP server is **management-only** — there is no
``pull`` / ``acknowledge`` tool. Publish is verified via MCP; arrival is
confirmed out-of-band with ``gcloud pubsub subscriptions pull``.
"""
from __future__ import annotations

import asyncio
import base64
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

load_dotenv(ROOT / ".env.local")
load_dotenv(ROOT / "adk_agent" / ".env")

from adk_agent.mcp_pubsub import (  # noqa: E402
    build_pubsub_toolset,
    load_pubsub_mcp_config,
    make_pubsub_resource_gate,
)

GREEN = "\033[32m"
RED = "\033[31m"
RESET = "\033[0m"

failures = 0


def ok(label: str, detail: str = "") -> None:
    print(f"  {GREEN}OK{RESET} {label}" + (f" - {detail}" if detail else ""))


def bad(label: str, detail: str = "") -> None:
    global failures
    failures += 1
    print(f"  {RED}FAIL{RESET} {label}" + (f" - {detail}" if detail else ""))


def fake_tool_context() -> Any:
    """Minimal stand-in for ADK's ToolContext.

    Real agent runs build a full InvocationContext (session, agent, etc.).
    For this script we never read state or content — we only need
    ``_invocation_context`` to be non-None so McpTool can construct a
    ReadonlyContext around it. Our header_provider ignores the context
    arg entirely.
    """
    return SimpleNamespace(_invocation_context=SimpleNamespace())


def _content_text(result: Any) -> str:
    content = getattr(result, "content", None)
    if content is None and isinstance(result, dict):
        content = result.get("content")
    if not content:
        return ""
    first = content[0]
    text = getattr(first, "text", None)
    if text is None and isinstance(first, dict):
        text = first.get("text")
    return text or ""


def _is_error(result: Any) -> bool:
    is_err = getattr(result, "isError", None)
    if is_err is None and isinstance(result, dict):
        is_err = result.get("isError")
    return bool(is_err)


async def main() -> int:
    print("\n=== Loaded config from .mcp.json ===")
    cfg = load_pubsub_mcp_config()
    if cfg is None:
        print("FAIL: no config loaded - check .mcp.json", file=sys.stderr)
        return 1
    print(json.dumps({
        "project_id": cfg.project_id,
        "allowed_tools": list(cfg.allowed_tools),
        "allowed_topics": list(cfg.allowed_topics),
        "allowed_subscriptions": list(cfg.allowed_subscriptions),
    }, indent=2))

    print("\n=== Initialize MCP toolset ===")
    toolset = build_pubsub_toolset(cfg)
    if toolset is None:
        bad("build_pubsub_toolset returned None - ADC unavailable?")
        return 1
    tools = await toolset.get_tools()
    tool_names = sorted(t.name for t in tools)
    ok("toolset built", f"{len(tools)} tools exposed")
    print(f"    tools: {tool_names}")

    print("\n=== Test 1: allowedTools filtering ===")
    destructive = [t for t in tool_names if t.startswith(("delete_", "update_"))]
    if destructive:
        bad("destructive tools should NOT be exposed", f"found: {destructive}")
    else:
        ok("destructive tools (delete_*, update_*) not exposed")
    for expected in ["list_topics", "get_topic", "list_subscriptions", "publish"]:
        if expected in tool_names:
            ok(f"{expected} present")
        else:
            bad(f"{expected} should be present per .mcp.json")

    by_name = {t.name: t for t in tools}
    ctx = fake_tool_context()

    print("\n=== Test 2: list_topics (live call) ===")
    res = await by_name["list_topics"].run_async(
        args={"projectId": cfg.project_id}, tool_context=ctx
    )
    if _is_error(res):
        bad("list_topics returned isError", _content_text(res)[:200])
    else:
        text = _content_text(res)
        if "sapphire-demo" in text:
            ok("list_topics succeeded; sapphire-demo found")
        else:
            bad("list_topics succeeded but sapphire-demo missing", text[:200])

    print("\n=== Test 3: get_topic sapphire-demo (allowed) ===")
    res = await by_name["get_topic"].run_async(
        args={"projectId": cfg.project_id, "topicId": "sapphire-demo"},
        tool_context=ctx,
    )
    if _is_error(res):
        bad("get_topic failed", _content_text(res)[:200])
    else:
        ok("get_topic sapphire-demo succeeded")

    print("\n=== Test 4: get_topic on non-allowed topic (gate must block) ===")
    gate = make_pubsub_resource_gate(cfg)
    gated = gate(
        tool=type("T", (), {"name": "get_topic"})(),
        args={"projectId": cfg.project_id, "topicId": "my-topic"},
        tool_context=ctx,
    )
    if gated is None:
        bad("gate failed to block non-allowed topic")
    elif "allowedTopics" not in (gated.get("content", [{}])[0].get("text") or ""):
        bad("blocked but message not from local gate", str(gated)[:200])
    else:
        ok("gate blocks non-allowed topic locally", gated["content"][0]["text"])

    print("\n=== Test 5: publish to sapphire-demo (allowed) ===")
    payload = json.dumps({
        "event": "live-mcp-allowlist-test-adk",
        "ts": "now",
        "note": "sent via ADK runtime mcp_pubsub.py code path",
    })
    res = await by_name["publish"].run_async(
        args={
            "projectId": cfg.project_id,
            "topicId": "sapphire-demo",
            "messages": [{"data": base64.b64encode(payload.encode()).decode()}],
        },
        tool_context=ctx,
    )
    if _is_error(res):
        bad("publish to sapphire-demo failed", _content_text(res)[:300])
    else:
        ok("publish to sapphire-demo accepted", _content_text(res)[:120])

    print("\n=== Test 6: publish to non-allowed topic (gate must block) ===")
    gated = gate(
        tool=type("T", (), {"name": "publish"})(),
        args={"projectId": cfg.project_id, "topicId": "my-topic"},
        tool_context=ctx,
    )
    if gated is None:
        bad("gate failed to block publish to non-allowed topic")
    else:
        ok("gate blocks publish to non-allowed topic", gated["content"][0]["text"])

    print("\n=== Test 7: get_subscription sapphire-demo-sub (allowed) ===")
    res = await by_name["get_subscription"].run_async(
        args={"projectId": cfg.project_id, "subscriptionId": "sapphire-demo-sub"},
        tool_context=ctx,
    )
    if _is_error(res):
        bad("get_subscription failed", _content_text(res)[:200])
    else:
        ok("get_subscription sapphire-demo-sub succeeded")

    print("\n=== Test 8: confirm message arrived (gcloud pubsub subscriptions pull) ===")
    proc = subprocess.run(
        [
            "gcloud", "pubsub", "subscriptions", "pull", "sapphire-demo-sub",
            f"--project={cfg.project_id}", "--auto-ack", "--limit=10",
            "--format=json",
        ],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        bad("gcloud pull failed", (proc.stderr or "")[:200])
    else:
        try:
            messages = json.loads(proc.stdout or "[]")
            decoded = [
                base64.b64decode(m["message"]["data"]).decode("utf-8")
                for m in messages
            ]
            found = next((d for d in decoded if "live-mcp-allowlist-test-adk" in d), None)
            if found:
                ok("test message round-tripped through Pub/Sub", found[:80])
            else:
                bad(f"pulled {len(messages)} messages but none matched test payload")
        except (ValueError, KeyError) as exc:
            bad("failed to parse gcloud pull output", str(exc))

    await toolset.close()
    print("\n=== Done ===")
    if failures:
        print(f"{RED}FAIL - {failures} check(s) failed{RESET}")
        return 1
    print(f"{GREEN}All checks passed{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
