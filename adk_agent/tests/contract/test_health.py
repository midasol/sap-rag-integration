import pytest
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_health_ok(monkeypatch):
    for k, v in [
        ("DATABASE_URL", "postgresql://x"),
        ("SAP_HOST", "h"),
        ("SAP_AUTH_TYPE", "basic"),
        ("EMBED_MODEL", "gemini-embedding-2"),
        ("EMBED_OUTPUT_DIM", "3072"),
        ("SAP_CRED_ENCRYPTION_KEY", "x" * 44),
    ]:
        monkeypatch.setenv(k, v)
    from adk_agent.server import build_app
    app = build_app(run_probes=False)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/healthz")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
