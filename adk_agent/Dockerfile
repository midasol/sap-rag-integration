FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml uv.lock ./
COPY adk_agent ./adk_agent
# Optional: ship .mcp.json so the Pub/Sub MCP toolset can self-configure.
# Trailing glob keeps the build green when the file is absent.
COPY .mcp.jso[n] ./

RUN uv sync --frozen

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8200

CMD ["python", "-m", "adk_agent.server"]
