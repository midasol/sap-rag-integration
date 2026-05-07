"""Fetch SAP OData $metadata for given services and emit a YAML snippet.

Usage:
    SAP_USER=... SAP_PASSWORD=... \
        uv run python scripts/fetch_sap_metadata.py \
        API_MATERIAL_STOCK_SRV API_PLANT_SRV \
        API_MATERIAL_DOCUMENT_SRV API_STORAGELOCATION_SRV

Reads SAP host/port/client from adk_agent/.env.
"""

from __future__ import annotations

import asyncio
import base64
import os
import ssl
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import aiohttp
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(REPO_ROOT / "adk_agent" / ".env")

SAP_HOST = os.environ["SAP_HOST"]
SAP_PORT = os.environ.get("SAP_PORT", "443")
SAP_CLIENT = os.environ.get("SAP_CLIENT", "100")
VERIFY_SSL = os.environ.get("SAP_VERIFY_SSL", "true").lower() == "true"
SAP_USER = os.environ.get("SAP_USER")
SAP_PASSWORD = os.environ.get("SAP_PASSWORD")

if not SAP_USER or not SAP_PASSWORD:
    sys.exit("ERROR: set SAP_USER and SAP_PASSWORD env vars")

NS = {
    "edmx": "http://schemas.microsoft.com/ado/2007/06/edmx",
    "edm": "http://schemas.microsoft.com/ado/2008/09/edm",
    "edm9": "http://schemas.microsoft.com/ado/2009/11/edm",
    "edm8": "http://schemas.microsoft.com/ado/2008/01/edm",
}


def _ssl_ctx() -> ssl.SSLContext | bool:
    if VERIFY_SSL:
        return True  # type: ignore[return-value]
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _basic_header() -> dict[str, str]:
    token = base64.b64encode(f"{SAP_USER}:{SAP_PASSWORD}".encode()).decode()
    return {"Authorization": f"Basic {token}", "Accept": "application/xml"}


async def fetch_metadata(session: aiohttp.ClientSession, service_id: str) -> str:
    url = (
        f"https://{SAP_HOST}:{SAP_PORT}/sap/opu/odata/sap/{service_id}/$metadata"
        f"?sap-client={SAP_CLIENT}"
    )
    async with session.get(url, headers=_basic_header()) as resp:
        if resp.status != 200:
            text = await resp.text()
            raise RuntimeError(
                f"fetch {service_id} failed: HTTP {resp.status}\n{text[:500]}"
            )
        return await resp.text()


def _local(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def parse_metadata(xml: str) -> dict[str, Any]:
    """Extract entity sets, key fields, and primary properties.

    Returns:
        {
          "version": "v2",
          "entities": [
            {
              "name": str,
              "key_fields": [str, ...],
              "properties": [str, ...],
              "navigations": [str, ...],
            },
            ...
          ],
        }
    """
    root = ET.fromstring(xml)
    # Discover OData version from edmx attribute
    version = "v2"
    for k, v in root.attrib.items():
        if _local(k) == "Version" and v.startswith("4"):
            version = "v4"

    # Build EntityType -> {keys, props, navs}
    entity_types: dict[str, dict[str, Any]] = {}
    for et in root.iter():
        if _local(et.tag) != "EntityType":
            continue
        name = et.attrib.get("Name")
        if not name:
            continue
        keys: list[str] = []
        props: list[str] = []
        navs: list[str] = []
        for child in et:
            ltag = _local(child.tag)
            if ltag == "Key":
                for pr in child:
                    if _local(pr.tag) == "PropertyRef":
                        keys.append(pr.attrib["Name"])
            elif ltag == "Property":
                props.append(child.attrib["Name"])
            elif ltag == "NavigationProperty":
                navs.append(child.attrib["Name"])
        entity_types[name] = {"keys": keys, "props": props, "navs": navs}

    # Map EntitySet name -> EntityType (strip namespace prefix)
    entity_sets: list[dict[str, Any]] = []
    for es in root.iter():
        if _local(es.tag) != "EntitySet":
            continue
        es_name = es.attrib.get("Name")
        et_ref = es.attrib.get("EntityType", "")
        et_name = et_ref.rsplit(".", 1)[-1]
        et_info = entity_types.get(et_name)
        if not et_info or not es_name:
            continue
        entity_sets.append(
            {
                "name": es_name,
                "key_fields": et_info["keys"],
                "properties": et_info["props"],
                "navigations": et_info["navs"],
            }
        )

    return {"version": version, "entities": entity_sets}


def to_yaml_snippet(service_id: str, parsed: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"  - id: {service_id}")
    lines.append(f'    name: "{service_id}"')
    lines.append(f'    path: "/sap/opu/odata/sap/{service_id}"')
    lines.append(f"    version: {parsed['version']}")
    lines.append('    description: ""')
    lines.append("    entities:")
    for ent in parsed["entities"]:
        keys = ent["key_fields"]
        primary = keys[0] if keys else ""
        comment = (
            f"        # composite ({', '.join(keys)})"
            if len(keys) > 1
            else ""
        )
        lines.append(f"      - name: {ent['name']}")
        if comment:
            lines.append(f"        key_field: {primary}{comment[7:]}")
        else:
            lines.append(f"        key_field: {primary}")
        lines.append(f'        description: ""')
        if ent["navigations"]:
            lines.append("        navigations:")
            for nav in ent["navigations"]:
                lines.append(f"          - {nav}")
        # Default select: keys + first ~6 non-key props
        sel: list[str] = list(keys)
        for p in ent["properties"]:
            if p in sel:
                continue
            sel.append(p)
            if len(sel) >= 8:
                break
        if sel:
            lines.append("        default_select:")
            for s in sel:
                lines.append(f"          - {s}")
    lines.append("    custom_headers: {}")
    return "\n".join(lines)


async def main() -> None:
    services = sys.argv[1:]
    if not services:
        sys.exit("usage: fetch_sap_metadata.py SERVICE_ID [SERVICE_ID ...]")

    timeout = aiohttp.ClientTimeout(total=60)
    connector = aiohttp.TCPConnector(ssl=_ssl_ctx())
    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as s:
        for sid in services:
            print(f"\n# === {sid} ===", file=sys.stderr)
            try:
                xml = await fetch_metadata(s, sid)
            except Exception as e:
                print(f"# ERROR fetching {sid}: {e}", file=sys.stderr)
                continue
            parsed = parse_metadata(xml)
            print(
                f"#   {len(parsed['entities'])} entity sets ({parsed['version']})",
                file=sys.stderr,
            )
            print(to_yaml_snippet(sid, parsed))


if __name__ == "__main__":
    asyncio.run(main())
