from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from google.adk.cli.fast_api import get_fast_api_app

from adk_agent import settings as _settings

log = logging.getLogger(__name__)
AGENTS_DIR = str(Path(__file__).resolve().parent.parent)

def build_app(run_probes: bool = True) -> FastAPI:
    s = _settings.load()
    if run_probes:
        from adk_agent.probes import run_all  # lazy import; probes.py may not exist yet
        run_all(s)
    app = get_fast_api_app(
        agents_dir=AGENTS_DIR,
        session_service_uri=None if s.session_backend == "memory" else "vertex://",
        allow_origins=["http://localhost:3000"],
        web=False,
    )

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.post("/sap/auth/basic")
    async def sap_auth_basic(payload: dict):
        """Verify SAP basic credentials and return the encrypted credential dict.

        Bypasses the LLM and ADK /run envelope (which can't accept user-side
        function_call parts per Gemini API rules). Callers seed the returned
        `state.sap_credentials` into ADK sessions via POST /apps/.../sessions/...
        """
        from adk_agent.tools.auth_tool import sap_authenticate

        class _Ctx:
            def __init__(self):
                self.state: dict = {}

        ctx = _Ctx()
        result = await sap_authenticate(
            method="basic",
            username=payload.get("username"),
            password=payload.get("password"),
            tool_context=ctx,
        )
        if result.get("success"):
            result["state"] = {"sap_credentials": ctx.state.get("sap_credentials")}
        return result

    return app

def main() -> None:  # pragma: no cover -- uvicorn entry point
    import uvicorn
    s = _settings.load()
    # Run probes synchronously in main() rather than via uvicorn's factory.
    # uvicorn already owns the event loop by the time it invokes a factory,
    # so probes.run_all (which uses asyncio.run) would crash with
    # "cannot be called from a running event loop".
    app = build_app(run_probes=True)
    uvicorn.run(app, host=s.adk_host, port=s.adk_port, reload=False)

if __name__ == "__main__":
    main()
