from __future__ import annotations

import math
import os

from google import genai

_MODEL = os.getenv("EMBED_MODEL", "gemini-embedding-2")
_DIM = int(os.getenv("EMBED_OUTPUT_DIM", "3072"))
_NORMALIZE = os.getenv("EMBED_NORMALIZE", "true").lower() == "true"
_client = None


def _normalize(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


async def embed_query(text: str) -> list[float]:
    global _client
    if _client is None:
        _client = genai.Client()
    resp = await _client.aio.models.embed_content(
        model=_MODEL,
        contents=text,
        config={"output_dimensionality": _DIM, "task_type": "RETRIEVAL_QUERY"},
    )
    v = list(resp.embeddings[0].values)
    if len(v) != _DIM:
        raise ValueError(f"unexpected embed dim {len(v)} != {_DIM}")
    return _normalize(v) if _NORMALIZE else v
