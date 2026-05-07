from __future__ import annotations

import logging

from adk_agent.rag.db import search_similar
from adk_agent.rag.embedding import embed_query

log = logging.getLogger(__name__)


async def search_documents(query: str, top_k: int = 8) -> dict:
    """Search the multimodal document corpus by semantic similarity.

    Args:
      query: natural language question or keywords
      top_k: number of results to return (default 8)
    Returns:
      {results: [{id, file_name, chunk_text, score}], count: int} on success
      {results: [], count: 0, warning: "..."} when embedding or vector DB fails
    """
    try:
        v = await embed_query(query)
    except Exception:
        log.exception("embed_query failed")
        return {"results": [], "count": 0, "warning": "embedding_unavailable"}
    try:
        rows = await search_similar(v, top_k=top_k)
    except Exception:
        log.exception("search_similar failed")
        return {"results": [], "count": 0, "warning": "vector_db_unavailable"}
    return {"results": rows, "count": len(rows)}
