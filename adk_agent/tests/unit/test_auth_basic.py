import pytest

from adk_agent.sap_gw_connector.config.settings import SAPConnectionConfig
from adk_agent.sap_gw_connector.core.auth import build_authenticator


def _cfg(**kw):
    base = dict(host="sap.example.com", port=44300, client="100",
                auth_type="basic", verify_ssl=False)
    base.update(kw)
    return SAPConnectionConfig(**base)


def test_basic_authenticator_sets_authorization_header():
    auth = build_authenticator(_cfg())
    auth.set_basic_credentials("admin", "p@ssw0rd")
    headers = auth.get_request_headers()
    assert headers["Authorization"].startswith("Basic ")


def test_basic_without_credentials_raises():
    auth = build_authenticator(_cfg())
    with pytest.raises(RuntimeError, match="credentials"):
        auth.get_request_headers()
