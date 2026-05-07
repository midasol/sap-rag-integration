from __future__ import annotations

import os
from dataclasses import dataclass
from dotenv import load_dotenv

# Load environment variables from .env file if it exists
load_dotenv()

REQUIRED = [
    "DATABASE_URL",
    "SAP_HOST",
    "EMBED_MODEL",
    "EMBED_OUTPUT_DIM",
    "SAP_CRED_ENCRYPTION_KEY",
]

DEFAULT_SAP_AUTH_TYPE = "basic"


@dataclass(frozen=True)
class Settings:
    database_url: str
    sap_host: str
    sap_auth_type: str
    embed_model: str
    embed_dim: int
    embed_normalize: bool
    adk_host: str
    adk_port: int
    session_backend: str
    project_id: str | None


def load() -> Settings:
    missing = [k for k in REQUIRED if not os.getenv(k)]
    if missing:
        raise RuntimeError(f"missing env: {missing}")
    return Settings(
        database_url=os.environ["DATABASE_URL"],
        sap_host=os.environ["SAP_HOST"],
        sap_auth_type=os.getenv("SAP_AUTH_TYPE", DEFAULT_SAP_AUTH_TYPE),
        embed_model=os.environ["EMBED_MODEL"],
        embed_dim=int(os.environ["EMBED_OUTPUT_DIM"]),
        embed_normalize=os.getenv("EMBED_NORMALIZE", "true").lower() == "true",
        adk_host=os.getenv("ADK_HOST", "0.0.0.0"),
        adk_port=int(os.getenv("ADK_PORT", "8200")),
        session_backend=os.getenv("ADK_SESSION_BACKEND", "memory"),
        project_id=os.getenv("GOOGLE_CLOUD_PROJECT"),
    )
