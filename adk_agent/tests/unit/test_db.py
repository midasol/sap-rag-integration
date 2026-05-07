"""Unit tests for adk_agent.rag.db — no network/DB required (all mocked)."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from adk_agent.rag import db

# ---------------------------------------------------------------------------
# test_format_vector_shape
# ---------------------------------------------------------------------------

def test_format_vector_shape():
    result = db._format_vector([0.1, 0.2])
    assert result.startswith("["), "must start with ["
    assert result.endswith("]"), "must end with ]"
    assert " " not in result, "must contain no spaces"
    inner = result[1:-1]
    parts = inner.split(",")
    assert len(parts) == 2, "must have 2 comma-separated values"


# ---------------------------------------------------------------------------
# test_search_similar_dim_mismatch_raises
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_search_similar_dim_mismatch_raises(monkeypatch):
    monkeypatch.setenv("EMBED_OUTPUT_DIM", "3072")
    with pytest.raises(ValueError, match="embedding dim mismatch"):
        await db.search_similar([0.1] * 10, top_k=5)


# ---------------------------------------------------------------------------
# test_search_similar_returns_mapped_rows
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_search_similar_returns_mapped_rows(monkeypatch):
    monkeypatch.setenv("EMBED_OUTPUT_DIM", "3072")

    fake_rows = [
        {"id": "uuid-1", "file_name": "a.pdf", "chunk_text": "hello", "score": 0.9},
        {"id": "uuid-2", "file_name": "b.pdf", "chunk_text": "world", "score": 0.8},
    ]

    fake_conn = MagicMock()
    fake_conn.fetch = AsyncMock(return_value=fake_rows)

    fake_acquire = MagicMock()
    fake_acquire.__aenter__ = AsyncMock(return_value=fake_conn)
    fake_acquire.__aexit__ = AsyncMock(return_value=None)

    fake_pool = MagicMock()
    fake_pool.acquire = MagicMock(return_value=fake_acquire)

    with patch.object(db, "get_pool", AsyncMock(return_value=fake_pool)):
        results = await db.search_similar([0.1] * 3072, top_k=2)

    assert len(results) == 2
    assert {"id", "file_name", "chunk_text", "score"}.issubset(results[0].keys())
    assert isinstance(results[0]["id"], str)
    assert isinstance(results[0]["file_name"], str)
    assert isinstance(results[0]["chunk_text"], str)
    assert isinstance(results[0]["score"], float)
    assert results[0]["score"] == 0.9
    assert results[1]["score"] == 0.8
