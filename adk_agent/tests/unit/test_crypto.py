import pytest
from cryptography.fernet import Fernet

from adk_agent import crypto


def test_roundtrip(monkeypatch):
    monkeypatch.setenv("SAP_CRED_ENCRYPTION_KEY", Fernet.generate_key().decode())
    crypto.reset()
    enc = crypto.encrypt("p@ss")
    assert enc != "p@ss"
    assert crypto.decrypt(enc) == "p@ss"


def test_missing_key_raises(monkeypatch):
    monkeypatch.delenv("SAP_CRED_ENCRYPTION_KEY", raising=False)
    crypto.reset()
    with pytest.raises(RuntimeError):
        crypto.encrypt("x")
