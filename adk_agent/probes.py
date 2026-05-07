from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import asyncpg

from adk_agent.sap_gw_connector.config.loader import ServicesConfigLoader

log = logging.getLogger(__name__)


async def _probe_services_yaml() -> None:
    p = Path(__file__).resolve().parent / "services.yaml"
    cfg = ServicesConfigLoader(p).load()
    if not cfg.services:
        raise RuntimeError("services.yaml has no services")


async def _probe_db(database_url: str, expected_dim: int) -> None:
    conn = await asyncpg.connect(database_url)
    try:
        row = await conn.fetchrow("SELECT to_regclass('embeddings') AS t")
        if row is None or row["t"] is None:
            raise RuntimeError("embeddings table not found")
    finally:
        await conn.close()


async def _probe_embed_model(model: str, dim: int) -> None:
    from adk_agent.rag.embedding import embed_query
    v = await embed_query("ping")
    if len(v) != dim:
        raise RuntimeError(f"embed dim {len(v)} != {dim}")


async def _probe_secret_manager(project_id: str | None) -> None:
    if not project_id:
        return  # optional in dev
    from google.cloud import secretmanager  # type: ignore
    sm = secretmanager.SecretManagerServiceClient()
    list(sm.list_secrets(request={"parent": f"projects/{project_id}"}))


async def run_all_async(s) -> None:
    await _probe_services_yaml()
    await _probe_db(s.database_url, s.embed_dim)
    await _probe_embed_model(s.embed_model, s.embed_dim)
    await _probe_secret_manager(s.project_id)


def run_all(s) -> None:
    asyncio.run(run_all_async(s))
