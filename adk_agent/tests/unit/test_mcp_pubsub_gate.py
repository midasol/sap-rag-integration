"""End-to-end tests of `make_pubsub_resource_gate`, the function we register
as the LlmAgent's `before_tool_callback`."""

from __future__ import annotations

from types import SimpleNamespace

from adk_agent.mcp_pubsub import (
    PubsubMCPConfig,
    make_pubsub_resource_gate,
)


def _build_cfg() -> PubsubMCPConfig:
    return PubsubMCPConfig(
        url="https://x",
        headers={"x-goog-user-project": "p"},
        project_id="p",
        allowed_tools=("publish", "list_topics"),
        allowed_topics=("sapphire-demo",),
        allowed_subscriptions=("sapphire-demo-sub",),
    )


def test_gate_returns_none_for_allowed_topic():
    gate = make_pubsub_resource_gate(_build_cfg())
    tool = SimpleNamespace(name="publish")
    assert gate(tool=tool, args={"projectId": "p", "topicId": "sapphire-demo"}, tool_context=None) is None


def test_gate_short_circuits_for_denied_topic():
    gate = make_pubsub_resource_gate(_build_cfg())
    tool = SimpleNamespace(name="publish")
    result = gate(
        tool=tool,
        args={"projectId": "p", "topicId": "secret"},
        tool_context=None,
    )
    assert result is not None
    assert result["isError"] is True
    assert "secret" in result["content"][0]["text"]
    assert "sapphire-demo" in result["content"][0]["text"]


def test_gate_passes_through_calls_without_resource_args():
    """list_topics-style call → no topicId/subscriptionId → pass through."""
    gate = make_pubsub_resource_gate(_build_cfg())
    tool = SimpleNamespace(name="list_topics")
    assert gate(tool=tool, args={"projectId": "p"}, tool_context=None) is None


def test_gate_handles_missing_args_dict():
    gate = make_pubsub_resource_gate(_build_cfg())
    tool = SimpleNamespace(name="anything")
    assert gate(tool=tool, args={}, tool_context=None) is None


def test_gate_subscription_path_works_too():
    gate = make_pubsub_resource_gate(_build_cfg())
    tool = SimpleNamespace(name="get_subscription")
    # Allowed
    assert (
        gate(
            tool=tool,
            args={"projectId": "p", "subscriptionId": "sapphire-demo-sub"},
            tool_context=None,
        )
        is None
    )
    # Denied
    result = gate(
        tool=tool,
        args={"projectId": "p", "subscriptionId": "other"},
        tool_context=None,
    )
    assert result is not None
    assert result["isError"] is True


def test_gate_with_empty_topic_allowlist_says_none():
    cfg = PubsubMCPConfig(
        url="x",
        headers={"x-goog-user-project": "p"},
        project_id="p",
        allowed_tools=("publish",),
        allowed_topics=(),  # empty → deny all
        allowed_subscriptions=(),
    )
    gate = make_pubsub_resource_gate(cfg)
    result = gate(
        tool=SimpleNamespace(name="publish"),
        args={"topicId": "sapphire-demo"},
        tool_context=None,
    )
    assert result is not None
    assert "(none)" in result["content"][0]["text"]
