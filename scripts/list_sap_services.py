"""List available SAP OData services from the catalog, filtered by name."""

from __future__ import annotations

import asyncio
import base64
import os
import ssl
import sys
from pathlib import Path

import aiohttp
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(REPO_ROOT / "adk_agent" / ".env")

SAP_HOST = os.environ["SAP_HOST"]
SAP_PORT = os.environ.get("SAP_PORT", "443")
SAP_CLIENT = os.environ.get("SAP_CLIENT", "100")
VERIFY_SSL = os.environ.get("SAP_VERIFY_SSL", "true").lower() == "true"
SAP_USER = os.environ["SAP_USER"]
SAP_PASSWORD = os.environ["SAP_PASSWORD"]


def _ssl_ctx():
    if VERIFY_SSL:
        return True
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _hdr() -> dict[str, str]:
    token = base64.b64encode(f"{SAP_USER}:{SAP_PASSWORD}".encode()).decode()
    return {"Authorization": f"Basic {token}", "Accept": "application/json"}


async def main() -> None:
    needles = [s.upper() for s in sys.argv[1:]] or [
        "MATERIAL", "PLANT", "STORAGE", "STOCK", "DOCUMENT",
    ]
    url = (
        f"https://{SAP_HOST}:{SAP_PORT}"
        f"/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection"
        f"?sap-client={SAP_CLIENT}&$format=json&$top=5000"
    )
    timeout = aiohttp.ClientTimeout(total=120)
    connector = aiohttp.TCPConnector(ssl=_ssl_ctx())
    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as s:
        async with s.get(url, headers=_hdr()) as resp:
            if resp.status != 200:
                text = await resp.text()
                sys.exit(f"catalog HTTP {resp.status}: {text[:500]}")
            data = await resp.json()

    rows = data.get("d", {}).get("results", [])
    print(f"# total catalog entries: {len(rows)}", file=sys.stderr)
    matches = []
    for r in rows:
        ident = (
            r.get("ID")
            or r.get("TechnicalServiceName")
            or r.get("Title")
            or ""
        )
        upper = str(ident).upper()
        if any(n in upper for n in needles):
            matches.append(r)
    print(f"# matched: {len(matches)}", file=sys.stderr)
    for r in matches:
        print(
            "{ID} | tech={TechnicalServiceName} | ver={Version} | title={Title}".format(
                ID=r.get("ID"),
                TechnicalServiceName=r.get("TechnicalServiceName"),
                Version=r.get("Version"),
                Title=r.get("Title"),
            )
        )


if __name__ == "__main__":
    asyncio.run(main())
