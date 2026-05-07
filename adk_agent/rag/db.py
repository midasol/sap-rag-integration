"""asyncpg-based pgvector cosine similarity search against the embeddings table."""
from __future__ import annotations

import asyncio
import os

import asyncpg

_pool: asyncpg.Pool | None = None
_lock = asyncio.Lock()


def _table() -> str:
    return os.getenv("RAG_TABLE", "embeddings")


def _expected_dim() -> int:
    return int(os.getenv("EMBED_OUTPUT_DIM", "3072"))


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is not None:
        return _pool
    async with _lock:
        if _pool is None:
            url = os.environ["DATABASE_URL"]
            _pool = await asyncpg.create_pool(dsn=url, min_size=1, max_size=10)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def _format_vector(embedding: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in embedding) + "]"


async def search_similar(embedding: list[float], top_k: int = 8) -> list[dict]:
    """Return up to *top_k* rows from the embeddings table ordered by cosine similarity.

    Each returned dict has keys: id, file_name, chunk_text, score.
    """
    if len(embedding) != _expected_dim():
        raise ValueError(
            f"embedding dim mismatch: {len(embedding)} != {_expected_dim()}"
        )

    pool = await get_pool()
    vec = _format_vector(embedding)
    table = _table()
    sql = f"""
      SELECT id, file_name, chunk_text,
             1 - (embedding <=> $1::vector) AS score
      FROM {table}
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, vec, top_k)

    return [
        {
            "id": str(r["id"]),
            "file_name": r["file_name"],
            "chunk_text": r["chunk_text"],
            "score": float(r["score"]),
        }
        for r in rows
    ]
