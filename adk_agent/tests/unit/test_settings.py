import pytest

from adk_agent import settings


def test_load_with_minimum(monkeypatch):
    for k, v in [
        ("DATABASE_URL", "postgresql://x"),
        ("SAP_HOST", "h"),
        ("SAP_AUTH_TYPE", "basic"),
        ("EMBED_MODEL", "gemini-embedding-001"),
        ("EMBED_OUTPUT_DIM", "3072"),
        ("SAP_CRED_ENCRYPTION_KEY", "x" * 44),
    ]:
        monkeypatch.setenv(k, v)
    s = settings.load()
    assert s.embed_dim == 3072
    assert s.sap_auth_type == "basic"


def test_missing_required_raises(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError):
        settings.load()


def test_sap_auth_type_defaults_to_basic(monkeypatch):
    for k, v in [
        ("DATABASE_URL", "postgresql://x"),
        ("SAP_HOST", "h"),
        ("EMBED_MODEL", "gemini-embedding-001"),
        ("EMBED_OUTPUT_DIM", "3072"),
        ("SAP_CRED_ENCRYPTION_KEY", "x" * 44),
    ]:
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("SAP_AUTH_TYPE", raising=False)
    s = settings.load()
    assert s.sap_auth_type == "basic"


def test_sap_auth_type_overridable(monkeypatch):
    for k, v in [
        ("DATABASE_URL", "postgresql://x"),
        ("SAP_HOST", "h"),
        ("SAP_AUTH_TYPE", "sap_oauth"),
        ("EMBED_MODEL", "gemini-embedding-001"),
        ("EMBED_OUTPUT_DIM", "3072"),
        ("SAP_CRED_ENCRYPTION_KEY", "x" * 44),
    ]:
        monkeypatch.setenv(k, v)
    s = settings.load()
    assert s.sap_auth_type == "sap_oauth"
