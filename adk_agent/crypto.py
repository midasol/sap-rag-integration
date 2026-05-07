from __future__ import annotations

import os

from cryptography.fernet import Fernet

_f: Fernet | None = None


def reset() -> None:
    global _f
    _f = None


def _get() -> Fernet:
    global _f
    if _f is None:
        key = os.getenv("SAP_CRED_ENCRYPTION_KEY")
        if not key:
            raise RuntimeError("SAP_CRED_ENCRYPTION_KEY not set")
        _f = Fernet(key.encode())
    return _f


def encrypt(plain: str) -> str:
    return _get().encrypt(plain.encode()).decode()


def decrypt(token: str) -> str:
    return _get().decrypt(token.encode()).decode()
