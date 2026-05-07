from unittest.mock import AsyncMock, patch

import pytest

from adk_agent import probes
from adk_agent import settings as st


@pytest.mark.asyncio
async def test_all_probes_pass(monkeypatch):
    for k, v in [
        ("DATABASE_URL", "postgresql://x"),
        ("SAP_HOST", "h"),
        ("SAP_AUTH_TYPE", "basic"),
        ("EMBED_MODEL", "gemini-embedding-001"),
        ("EMBED_OUTPUT_DIM", "3072"),
        ("SAP_CRED_ENCRYPTION_KEY", "x" * 44),
    ]:
        monkeypatch.setenv(k, v)
    s = st.load()
    with patch("adk_agent.probes._probe_db", AsyncMock()), \
         patch("adk_agent.probes._probe_embed_model", AsyncMock()), \
         patch("adk_agent.probes._probe_secret_manager", AsyncMock()):
        await probes.run_all_async(s)

@pytest.mark.asyncio
async def test_db_probe_failure_raises(monkeypatch):
    s = type("S", (object,), {
        "database_url": "postgresql://x",
        "embed_dim": 3072,
        "embed_model": "m",
        "project_id": None,
    })
    with patch("adk_agent.probes._probe_db", AsyncMock(side_effect=RuntimeError("db down"))), \
         patch("adk_agent.probes._probe_services_yaml", AsyncMock()):
        with pytest.raises(RuntimeError):
            await probes.run_all_async(s)
