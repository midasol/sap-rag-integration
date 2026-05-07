#!/usr/bin/env python3
"""Mode B — deploy the ADK agent to Vertex AI Agent Engine.

Bundles `adk_agent/` (the Python package containing `root_agent`) plus
`.mcp.json` (so the Pub/Sub MCP toolset self-configures), then calls
`vertexai.agent_engines.create()` (or `.update()` when --update is passed).

Network topology assumed:
- Agent Engine reaches SAP via PSC interface + network attachment created
  by `setup-agent-engine.sh`.
- Agent Engine reaches Cloud SQL via TCP to the instance's Private IP
  (PSA-peered with VPC_NETWORK by `setup-cloud-sql.sh`).

Usage:
    # Create new
    python deploy/deploy-agent-engine.py --project <PROJECT_ID>

    # Update existing
    python deploy/deploy-agent-engine.py --project <PROJECT_ID> \\
        --update projects/<N>/locations/us-central1/reasoningEngines/<ID>

The deploy environment is read from deploy/.env.agent-engine. Required
keys are validated up-front; missing keys exit before any GCP call.
"""
from __future__ import annotations

import argparse
import os
import sys
import urllib.parse
from pathlib import Path

# Resolve project root regardless of cwd.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEPLOY_DIR = PROJECT_ROOT / "deploy"
ENV_FILE = DEPLOY_DIR / ".env.agent-engine"

REQUIRED_ENV = (
    "PROJECT_ID",
    "VPC_NETWORK",
    "NETWORK_ATTACHMENT_NAME",
    "CLOUD_SQL_DB",
    "CLOUD_SQL_USER",
    "CLOUD_SQL_PASSWORD",
    "CLOUD_SQL_PRIVATE_IP",
    "EMBED_MODEL",
    "EMBED_OUTPUT_DIM",
    "SAP_HOST",
    "SAP_CREDENTIALS_SECRET",
    "SAP_CRED_ENCRYPTION_KEY_SECRET",
    "AGENT_ENGINE_SA",
)

# Python package deps for the bundled agent. FastAPI / uvicorn are intentionally
# excluded — Agent Engine provides its own HTTP layer; only `root_agent` and
# its tool dependencies are needed at runtime.
REQUIREMENTS = [
    "google-cloud-aiplatform[adk,agent_engines]>=1.128.0",
    "google-adk>=1.27.0,<2.0.0",
    "google-genai>=1.44.0",
    "google-cloud-secret-manager>=2.20.0",
    "asyncpg>=0.29.0",
    "pgvector>=0.3.0",
    "cryptography>=42.0",
    "xmltodict>=0.13.0",
    "pyyaml>=6.0",
    "aiohttp>=3.9",
    "pydantic>=2.7",
    "structlog>=24.1.0",
    "python-dotenv>=1.0",
    "nest-asyncio>=1.6",
]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--project", help="GCP project ID. Overrides PROJECT_ID from env file.")
    p.add_argument(
        "--update",
        metavar="RESOURCE_NAME",
        help="Update an existing Agent Engine resource by full resource name.",
    )
    p.add_argument(
        "--env-file",
        default=str(ENV_FILE),
        help=f"Path to deploy env file (default: {ENV_FILE}).",
    )
    return p.parse_args()


def load_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        sys.exit(f"ERROR: {path} not found. Copy deploy/.env.agent-engine.example first.")
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        val = val.strip().strip('"').strip("'")
        out[key.strip()] = val
    return out


def fetch_secret(project_id: str, secret_name: str) -> str:
    """Fetch latest secret version payload as text."""
    from google.cloud import secretmanager

    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{project_id}/secrets/{secret_name}/versions/latest"
    response = client.access_secret_version(request={"name": name})
    return response.payload.data.decode("utf-8")


def build_database_url(env: dict[str, str]) -> str:
    user = env["CLOUD_SQL_USER"]
    pw = urllib.parse.quote(env["CLOUD_SQL_PASSWORD"], safe="")
    host = env["CLOUD_SQL_PRIVATE_IP"]
    db = env["CLOUD_SQL_DB"]
    return f"postgresql://{user}:{pw}@{host}:5432/{db}"


def main() -> None:
    args = parse_args()
    env = load_env_file(Path(args.env_file))

    if args.project:
        env["PROJECT_ID"] = args.project

    missing = [k for k in REQUIRED_ENV if not env.get(k) or env.get(k) == "replace-me"]
    if missing:
        sys.exit(f"ERROR: missing required env keys in {args.env_file}: {missing}")

    project_id = env["PROJECT_ID"]
    region = env.get("REGION", "us-central1")
    staging_bucket = env.get("STAGING_BUCKET") or f"gs://{project_id}_cloudbuild"
    sa_email = f"{env['AGENT_ENGINE_SA']}@{project_id}.iam.gserviceaccount.com"
    network_attachment = (
        f"projects/{project_id}/regions/{region}"
        f"/networkAttachments/{env['NETWORK_ATTACHMENT_NAME']}"
    )
    display_name = env.get("AGENT_DISPLAY_NAME", "sapphire26 SAP RAG Agent")

    # The agent module reads SAP_AGENT_MODEL at import; set it before
    # the import below so the deploy preview reflects what will run.
    os.environ.setdefault("SAP_AGENT_MODEL", env.get("SAP_AGENT_MODEL", "gemini-3.1-pro-preview"))
    os.environ["GOOGLE_CLOUD_PROJECT"] = project_id

    print("=" * 60)
    print("Vertex AI Agent Engine deployment")
    print("=" * 60)
    print(f"Project:            {project_id}")
    print(f"Region:             {region}")
    print(f"Staging bucket:     {staging_bucket}")
    print(f"Service account:    {sa_email}")
    print(f"Network attachment: {network_attachment}")
    print(f"Display name:       {display_name}")
    print(f"Cloud SQL:          {env['CLOUD_SQL_USER']}@{env['CLOUD_SQL_PRIVATE_IP']}:5432/{env['CLOUD_SQL_DB']}")
    print()

    # Vertex SDK init.
    import vertexai
    from vertexai import agent_engines

    vertexai.init(
        project=project_id,
        location=region,
        staging_bucket=staging_bucket,
    )

    # Import the agent (this triggers the Pub/Sub MCP wiring at module load
    # time — `.mcp.json` will be searched per the path-resolution logic in
    # adk_agent/mcp_pubsub.py:_default_mcp_config_path).
    sys.path.insert(0, str(PROJECT_ROOT))
    import adk_agent.agent as agent_module  # noqa: E402

    print(f"Agent name: {agent_module.root_agent.name}")
    print(f"Tools:      {[t.__name__ if hasattr(t, '__name__') else type(t).__name__ for t in agent_module.root_agent.tools]}")
    print()

    # Resolve runtime secrets from Secret Manager.
    print("Fetching runtime secrets...")
    sap_cred_key = fetch_secret(project_id, env["SAP_CRED_ENCRYPTION_KEY_SECRET"])
    print(f"  {env['SAP_CRED_ENCRYPTION_KEY_SECRET']}: {len(sap_cred_key)} chars (Fernet)")

    # Build env_vars injected into the deployed container.
    deployed_env: dict[str, str] = {
        "DATABASE_URL": build_database_url(env),
        "SAP_AGENT_MODEL": env.get("SAP_AGENT_MODEL", "gemini-3.1-pro-preview"),
        "EMBED_MODEL": env["EMBED_MODEL"],
        "EMBED_OUTPUT_DIM": env["EMBED_OUTPUT_DIM"],
        "EMBED_NORMALIZE": env.get("EMBED_NORMALIZE", "true"),
        "SAP_HOST": env["SAP_HOST"],
        "SAP_PORT": env.get("SAP_PORT", "44300"),
        "SAP_CLIENT": env.get("SAP_CLIENT", "100"),
        "SAP_VERIFY_SSL": env.get("SAP_VERIFY_SSL", "true"),
        "SAP_AUTH_TYPE": env.get("SAP_AUTH_TYPE", "sap_oauth"),
        "SAP_CRED_ENCRYPTION_KEY": sap_cred_key,
        "ADK_SESSION_BACKEND": env.get("ADK_SESSION_BACKEND", "vertex"),
        # GOOGLE_CLOUD_PROJECT is reserved by Agent Engine and injected automatically.
        "SAP_CREDENTIALS_SECRET": env["SAP_CREDENTIALS_SECRET"],
        # Where Agent Engine extracts extra_packages — ensures `.mcp.json`
        # is found by adk_agent/mcp_pubsub.py at runtime.
        "MCP_CONFIG_PATH": "/app/.mcp.json",
    }

    # Pass through SAP OAuth env if present in env file.
    for opt in (
        "SAP_OAUTH_CLIENT_ID",
        "SAP_OAUTH_CLIENT_SECRET",
        "SAP_OAUTH_TOKEN_URL",
        "SAP_OAUTH_AUTHORIZE_URL",
        "SAP_OAUTH_REDIRECT_URI",
    ):
        if env.get(opt):
            deployed_env[opt] = env[opt]

    extra_packages = ["./adk_agent"]
    mcp_json = PROJECT_ROOT / ".mcp.json"
    if mcp_json.exists():
        extra_packages.append("./.mcp.json")
        print(f"Bundling {mcp_json.name}")

    resource_limits = {
        "cpu": env.get("AGENT_CPU", "4"),
        "memory": env.get("AGENT_MEMORY", "8Gi"),
    }
    print(f"Resource limits:    {resource_limits}")
    print()

    app = agent_engines.AdkApp(
        agent=agent_module.root_agent,
        enable_tracing=True,
    )

    common_kwargs = dict(
        agent_engine=app,
        requirements=REQUIREMENTS,
        extra_packages=extra_packages,
        display_name=display_name,
        env_vars=deployed_env,
        resource_limits=resource_limits,
        psc_interface_config={"network_attachment": network_attachment},
    )

    try:
        if args.update:
            print(f"Updating existing Agent Engine: {args.update}")
            remote = agent_engines.update(resource_name=args.update, **common_kwargs)
        else:
            print("Creating new Agent Engine...")
            remote = agent_engines.create(service_account=sa_email, **common_kwargs)
    except Exception as exc:
        print(f"\nDeployment failed: {exc}", file=sys.stderr)
        raise

    print()
    print("=" * 60)
    print("Deployment complete")
    print("=" * 60)
    print(f"Resource name:  {remote.resource_name}")
    print()
    print("Register in Gemini Enterprise:")
    print("  https://gemini.google.com/enterprise → Agents → Register agent")
    print(f"  Provide the resource name above.")


if __name__ == "__main__":
    main()
