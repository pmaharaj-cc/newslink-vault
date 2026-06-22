# Trinidad News Knowledge Base

Daily articles from Trinidad Express, processed into linked Obsidian notes.

**Roadmap:** Express pipeline first (current). Guardian and Newsday planned — see `monitor.py` in the dev fork.

## Structure

- `Articles/` — one note per article
- `Daily/` — daily index (all articles for that date)
- `People/` — named individuals (criminal-record stubs when applicable)
- `Orgs/` — organizations
- `Places/` — locations
- `Authors/` — journalists (manual or future auto-stubs)
- `Topics/` — topic hub notes
- `local/` — your personal notes (not pushed upstream)
- `data/` — `processed.json` (URL dedup), `entities.json` (entity graph)

## Sync (Obsidian)

1. Install community plugin **Obsidian Git**
2. Open this folder as your vault
3. Pull on startup (configured in plugin settings — push disabled)
4. New articles appear when the Cloudflare worker commits to GitHub

## Pipeline

| Component | File |
|-----------|------|
| Hourly worker | `worker.js` + Cloudflare cron |
| Catch-up (manual) | `catchup.py` via GitHub Actions → "Catch-up Articles" |
| Backfill (reprocess) | `backfill.py` via GitHub Actions → "Backfill Articles" |

Trigger worker manually: `GET /run?secret=<TRIGGER_SECRET>` on your Cloudflare Worker URL.