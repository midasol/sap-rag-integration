import math
from unittest.mock import AsyncMock, patch

import pytest

from adk_agent.rag import embedding


@pytest.mark.asyncio
async def test_embed_query_returns_3072_normalized():
    fake = [0.1] * 3072
    with patch("adk_agent.rag.embedding._client") as c:
        c.aio.models.embed_content = AsyncMock(
            return_value=type("R", (), {"embeddings": [type("E", (), {"values": fake})]})()
        )
        v = await embedding.embed_query("hello")
    assert len(v) == 3072
    norm = math.sqrt(sum(x * x for x in v))
    assert abs(norm - 1.0) < 1e-3
