"""Integration test for adk_agent.rag.db using a real pgvector container.

Skipped automatically when Docker is unavailable (e.g. local dev without Docker).
"""
from __future__ import annotations

import shutil
import subprocess

import pytest


def _docker_available() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        r = subprocess.run(["docker", "info"], capture_output=True, timeout=3)
        return r.returncode == 0
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _docker_available(), reason="Docker not available"
)

from testcontainers.postgres import PostgresContainer  # noqa: E402


@pytest.fixture(scope="module")
def pg():
    with PostgresContainer("pgvector/pgvector:pg16") as c:
        yield c


@pytest.mark.asyncio
async def test_search_similar_returns_top_k(pg, monkeypatch):
    from adk_agent.rag import db

    url = pg.get_connection_url().replace("postgresql+psycopg2", "postgresql")
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("EMBED_OUTPUT_DIM", "3072")
    monkeypatch.setenv("RAG_TABLE", "embeddings")

    # Reset any cached pool so we pick up the new DATABASE_URL
    await db.close_pool()
    pool = await db.get_pool()

    async with pool.acquire() as conn:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        await conn.execute(
            """
            CREATE TABLE embeddings (
              id uuid primary key default gen_random_uuid(),
              file_name text,
              chunk_text text,
              embedding vector(3072)
            )
            """
        )
        v = "[" + ",".join(["0.1"] * 3072) + "]"
        for i in range(3):
            await conn.execute(
                "INSERT INTO embeddings(file_name, chunk_text, embedding)"
                " VALUES($1, $2, $3::vector)",
                f"file{i}.pdf",
                f"chunk{i}",
                v,
            )

    results = await db.search_similar([0.1] * 3072, top_k=2)

    assert len(results) == 2
    assert all(
        {"id", "file_name", "chunk_text", "score"}.issubset(r.keys())
        for r in results
    )

    await db.close_pool()
