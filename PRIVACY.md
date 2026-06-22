# Privacy Notice

This repository is public and open source.

## What is published

- **Articles/** — structured notes derived from publicly available Trinidad Express news articles
- **People/**, **Orgs/**, **Places/** — entity stubs linked across articles
- **data/entities.json** — machine-readable graph of people, roles, and legal statuses mentioned in news coverage

All article content originates from public news sources. The vault aggregates and links information that is already publicly reported.

## What is not published

- API keys (`GROQ_API_KEY`, `GITHUB_TOKEN`, `TRIGGER_SECRET`) — stored only in Cloudflare Worker and GitHub Actions secrets
- Personal Obsidian workspace settings (excluded via `.gitignore`)
- Notes in `local/` — personal annotations, never pushed upstream

## Legal statuses

Some `People/` notes include `legal_statuses` (e.g. charged, convicted) when explicitly reported in source articles. This is editorial aggregation of public court and police reporting, not a criminal records database.

## Your local clone

If you add personal notes, keep them under `local/` or configure Obsidian Git with pull-only mode (`disablePush: true`) so local edits are not pushed to this repository.