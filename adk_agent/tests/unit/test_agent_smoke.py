"""Smoke test: root_agent imports with the SAP/RAG tools (and optionally the
Pub/Sub MCP toolset when `.mcp.json` is present + ADC is available)."""


def test_root_agent_imports_with_expected_tools():
    from adk_agent.agent import root_agent
    assert root_agent.name == "sapphire26_agent"
    # Always 5 base tools; with Pub/Sub MCP loaded we get one extra toolset.
    assert len(root_agent.tools) in (5, 6)
