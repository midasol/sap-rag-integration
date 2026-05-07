"""Config-loading tests for adk_agent.mcp_pubsub.

Verifies the `.mcp.json` parser is deny-by-default for all three allowlist
fields and matches the policy used by the sibling Next.js project's
mcp-pubsub.test.ts.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from adk_agent.mcp_pubsub import (
    PubsubMCPConfig,
    _check_resource_allowed,
    _extract_bare_name,
    load_pubsub_mcp_config,
)


def _write_config(tmp_path: Path, content: dict) -> Path:
    p = tmp_path / ".mcp.json"
    p.write_text(json.dumps(content), encoding="utf-8")
    return p


def test_returns_none_when_file_missing(tmp_path: Path):
    assert load_pubsub_mcp_config(tmp_path / "missing.json") is None


def test_returns_none_when_file_malformed(tmp_path: Path):
    p = tmp_path / ".mcp.json"
    p.write_text("{ this is not json", encoding="utf-8")
    assert load_pubsub_mcp_config(p) is None


def test_returns_none_when_pubsub_block_absent(tmp_path: Path):
    p = _write_config(tmp_path, {"mcpServers": {"other": {"type": "http", "url": "x"}}})
    assert load_pubsub_mcp_config(p) is None


def test_returns_none_when_x_goog_user_project_missing(tmp_path: Path):
    p = _write_config(
        tmp_path,
        {
            "mcpServers": {
                "pubsub": {"type": "http", "url": "https://x", "headers": {}}
            }
        },
    )
    assert load_pubsub_mcp_config(p) is None


def test_parses_full_block_with_allowlists(tmp_path: Path):
    p = _write_config(
        tmp_path,
        {
            "mcpServers": {
                "pubsub": {
                    "type": "http",
                    "url": "https://pubsub.googleapis.com/mcp",
                    "headers": {"x-goog-user-project": "my-project"},
                    "allowedTools": ["list_topics", "publish"],
                    "allowedTopics": ["sapphire-demo"],
                    "allowedSubscriptions": ["sapphire-demo-sub"],
                }
            }
        },
    )
    cfg = load_pubsub_mcp_config(p)
    assert cfg is not None
    assert cfg.url == "https://pubsub.googleapis.com/mcp"
    assert cfg.project_id == "my-project"
    assert cfg.allowed_tools == ("list_topics", "publish")
    assert cfg.allowed_topics == ("sapphire-demo",)
    assert cfg.allowed_subscriptions == ("sapphire-demo-sub",)


def test_deny_by_default_when_allowlist_fields_missing(tmp_path: Path):
    """Missing allowlist fields ⇒ empty tuple (deny-by-default)."""
    p = _write_config(
        tmp_path,
        {
            "mcpServers": {
                "pubsub": {
                    "type": "http",
                    "url": "https://pubsub.googleapis.com/mcp",
                    "headers": {"x-goog-user-project": "my-project"},
                }
            }
        },
    )
    cfg = load_pubsub_mcp_config(p)
    assert cfg is not None
    assert cfg.allowed_tools == ()
    assert cfg.allowed_topics == ()
    assert cfg.allowed_subscriptions == ()


def test_extract_bare_name_handles_three_forms():
    assert _extract_bare_name("sapphire-demo", "topics") == "sapphire-demo"
    assert _extract_bare_name("topics/sapphire-demo", "topics") == "sapphire-demo"
    assert (
        _extract_bare_name("projects/p/topics/sapphire-demo", "topics")
        == "sapphire-demo"
    )
    assert (
        _extract_bare_name("projects/p/subscriptions/x", "subscriptions") == "x"
    )


# ----- _check_resource_allowed (the heart of the resource gate) -----


def _cfg(**overrides) -> PubsubMCPConfig:
    base = dict(
        url="https://x",
        headers={"x-goog-user-project": "p"},
        project_id="p",
        allowed_tools=("publish",),
        allowed_topics=(),
        allowed_subscriptions=(),
    )
    base.update(overrides)
    return PubsubMCPConfig(**base)


def test_allows_call_with_no_resource_args():
    """list_topics-style calls without topicId/subscriptionId pass through."""
    cfg = _cfg(allowed_topics=("anything",))
    assert _check_resource_allowed({"projectId": "p"}, cfg) is None


def test_blocks_topic_arg_when_allowedTopics_empty():
    cfg = _cfg(allowed_topics=())
    msg = _check_resource_allowed({"topicId": "any"}, cfg)
    assert msg is not None
    assert "any" in msg and "(none)" in msg


def test_allows_topic_in_allowlist():
    cfg = _cfg(allowed_topics=("sapphire-demo",))
    assert _check_resource_allowed({"topicId": "sapphire-demo"}, cfg) is None


def test_blocks_topic_outside_allowlist():
    cfg = _cfg(allowed_topics=("sapphire-demo",))
    msg = _check_resource_allowed({"topicId": "other"}, cfg)
    assert msg is not None
    assert "other" in msg and "sapphire-demo" in msg


def test_topic_arg_full_resource_path_normalizes_to_bare():
    cfg = _cfg(allowed_topics=("sapphire-demo",))
    assert (
        _check_resource_allowed(
            {"topicId": "projects/p/topics/sapphire-demo"}, cfg
        )
        is None
    )


def test_subscription_gate_independent_of_topic_gate():
    cfg = _cfg(
        allowed_topics=("sapphire-demo",),
        allowed_subscriptions=("sapphire-demo-sub",),
    )
    # Allowed sub
    assert (
        _check_resource_allowed({"subscriptionId": "sapphire-demo-sub"}, cfg)
        is None
    )
    # Denied sub
    msg = _check_resource_allowed({"subscriptionId": "other-sub"}, cfg)
    assert msg is not None
    assert "other-sub" in msg


def test_subscription_arg_alias_keys_are_recognized():
    cfg = _cfg(allowed_subscriptions=("ok",))
    # All three accepted alias keys
    for key in ("subscriptionId", "subscription", "subscriptionName"):
        assert _check_resource_allowed({key: "ok"}, cfg) is None
        assert _check_resource_allowed({key: "denied"}, cfg) is not None
