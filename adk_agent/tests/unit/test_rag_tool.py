from unittest.mock import AsyncMock, patch

import pytest

from adk_agent.tools import rag_tool


@pytest.mark.asyncio
async def test_search_documents_happy():
    fake_rows = [{"id": "uuid-1", "file_name": "f.pdf", "chunk_text": "x", "score": 0.9}]
    with patch("adk_agent.tools.rag_tool.embed_query", AsyncMock(return_value=[0.1] * 3072)), \
         patch("adk_agent.tools.rag_tool.search_similar", AsyncMock(return_value=fake_rows)):
        out = await rag_tool.search_documents("hi", top_k=5)
    assert out["count"] == 1
    assert out["results"][0]["chunk_text"] == "x"
    assert out["results"][0]["file_name"] == "f.pdf"
    assert "warning" not in out


@pytest.mark.asyncio
async def test_search_documents_db_down_returns_warning():
    with patch("adk_agent.tools.rag_tool.embed_query", AsyncMock(return_value=[0.1] * 3072)), \
         patch("adk_agent.tools.rag_tool.search_similar", AsyncMock(side_effect=RuntimeError("db down"))):
        out = await rag_tool.search_documents("hi")
    assert out["results"] == []
    assert out["count"] == 0
    assert out["warning"] == "vector_db_unavailable"


@pytest.mark.asyncio
async def test_search_documents_embed_down_returns_warning():
    with patch("adk_agent.tools.rag_tool.embed_query", AsyncMock(side_effect=RuntimeError("api down"))):
        out = await rag_tool.search_documents("hi")
    assert out["results"] == []
    assert out["warning"] == "embedding_unavailable"
