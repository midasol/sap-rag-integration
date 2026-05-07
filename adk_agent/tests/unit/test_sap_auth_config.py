from adk_agent.sap_auth_config import build_sap_auth_config


def test_returns_none_when_env_incomplete(monkeypatch):
    for k in (
        "SAP_OAUTH_CLIENT_ID",
        "SAP_OAUTH_CLIENT_SECRET",
        "SAP_OAUTH_AUTHORIZE_URL",
        "SAP_OAUTH_TOKEN_URL",
    ):
        monkeypatch.delenv(k, raising=False)
    assert build_sap_auth_config() is None


def test_builds_authconfig_when_env_complete(monkeypatch):
    monkeypatch.setenv("SAP_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("SAP_OAUTH_CLIENT_SECRET", "csec")
    monkeypatch.setenv("SAP_OAUTH_AUTHORIZE_URL", "https://example/oauth/authorize")
    monkeypatch.setenv("SAP_OAUTH_TOKEN_URL", "https://example/oauth/token")
    monkeypatch.setenv("SAP_OAUTH_SCOPE", "read write")
    monkeypatch.setenv("SAP_OAUTH_REDIRECT_URI", "https://app/callback")

    cfg = build_sap_auth_config()
    assert cfg is not None
    assert cfg.raw_auth_credential.oauth2.client_id == "cid"
    assert cfg.raw_auth_credential.oauth2.redirect_uri == "https://app/callback"
    flow = cfg.auth_scheme.flows.authorizationCode
    assert flow.authorizationUrl == "https://example/oauth/authorize"
    assert flow.tokenUrl == "https://example/oauth/token"
    assert set(flow.scopes.keys()) == {"read", "write"}


def test_redirect_uri_blank_becomes_none(monkeypatch):
    monkeypatch.setenv("SAP_OAUTH_CLIENT_ID", "cid")
    monkeypatch.setenv("SAP_OAUTH_CLIENT_SECRET", "csec")
    monkeypatch.setenv("SAP_OAUTH_AUTHORIZE_URL", "https://example/a")
    monkeypatch.setenv("SAP_OAUTH_TOKEN_URL", "https://example/t")
    monkeypatch.delenv("SAP_OAUTH_SCOPE", raising=False)
    monkeypatch.delenv("SAP_OAUTH_REDIRECT_URI", raising=False)

    cfg = build_sap_auth_config()
    assert cfg is not None
    assert cfg.raw_auth_credential.oauth2.redirect_uri is None
    assert cfg.auth_scheme.flows.authorizationCode.scopes == {}
