#!/usr/bin/env python3
"""
Vault overhaul entry point — DO NOT RUN until re-parse is cheap.

Usage (future):
    python overhaul.py --mode=stubs-only
    python overhaul.py --mode=link-normalize
    python overhaul.py --mode=reparse-legacy
    python overhaul.py --mode=full

Reads data/vault_schema.json for target state and data/debt_registry.json for gap inventory.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

VAULT = Path(__file__).parent
SCHEMA_PATH = VAULT / "data" / "vault_schema.json"
DEBT_PATH = VAULT / "data" / "debt_registry.json"

MODES = {
    "stubs-only": "Scan Articles/ wikilinks → create missing People/Orgs/Places/Authors stubs (no LLM)",
    "link-normalize": "Rewrite bare [[X]] in secondary sections → typed [[People/X]] etc.",
    "reparse-legacy": "Re-fetch url from legacy-tier article frontmatter → Groq re-extract → merge stubs",
    "full": "link-normalize → reparse-legacy → rebuild entities.json → validate against vault_schema.json",
}


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def load_debt_registry() -> dict:
    if not DEBT_PATH.exists():
        return {"entries": []}
    return json.loads(DEBT_PATH.read_text(encoding="utf-8"))


def run_stubs_only(_schema: dict) -> None:
    raise NotImplementedError("Run when ready — scan wikilinks and write minimal stubs")


def run_link_normalize(_schema: dict) -> None:
    raise NotImplementedError("Run when ready — normalize bare wikilinks in Articles/")


def run_reparse_legacy(_schema: dict) -> None:
    raise NotImplementedError("Run when ready — re-extract extraction_tier=legacy articles")


def run_full(schema: dict) -> None:
    run_link_normalize(schema)
    run_reparse_legacy(schema)
    raise NotImplementedError("Run when ready — rebuild entities.json and validate")


def main() -> None:
    parser = argparse.ArgumentParser(description="NewsLink vault overhaul (future one-click)")
    parser.add_argument("--mode", choices=list(MODES), required=True)
    parser.add_argument("--dry-run", action="store_true", help="Report actions without writing")
    args = parser.parse_args()

    schema = load_schema()
    debts = load_debt_registry()
    print(f"Mode: {args.mode} — {MODES[args.mode]}")
    print(f"Schema v{schema.get('schema_version')} / pipeline v{schema.get('pipeline_version')}")
    print(f"Debt entries on record: {len(debts.get('entries', []))}")
    if args.dry_run:
        print("Dry run — no changes written")
        return

    dispatch = {
        "stubs-only": run_stubs_only,
        "link-normalize": run_link_normalize,
        "reparse-legacy": run_reparse_legacy,
        "full": run_full,
    }
    dispatch[args.mode](schema)


if __name__ == "__main__":
    main()