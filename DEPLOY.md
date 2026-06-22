# Deploy Cloudflare Worker

The live worker URL: `https://newslink-vault.proger-yung.workers.dev`

## Prerequisites

- Cloudflare API token with Workers edit permission
- Secrets in Cloudflare dashboard: `GROQ_API_KEY`, `GITHUB_TOKEN`, `TRIGGER_SECRET`
- Same `GROQ_API_KEY` in GitHub Actions secrets (repo → Settings → Secrets → `GROQ_API_KEY`)
- GitHub PAT with `repo` scope in Cloudflare `GITHUB_TOKEN` and Actions `PAT_TOKEN`

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| Worker `401 Bad credentials` | Regenerate GitHub PAT → update Cloudflare `GITHUB_TOKEN` |
| Catchup `Groq HTTP 403` | Groq blocked `llama-3.3-70b-versatile` for dev tier (Jun 2026). Code now uses `qwen/qwen3.6-27b` — redeploy worker + re-run catchup |
| Catchup `0 articles` but URLs pending | Check Actions log for Groq/GitHub errors; verify secrets above |

## Deploy updated worker.js

```bash
cd newslink-vault
CLOUDFLARE_API_TOKEN=your_token npx wrangler deploy
```

## Verify

```bash
curl "https://newslink-vault.proger-yung.workers.dev/run?secret=YOUR_TRIGGER_SECRET"
```

Expect JSON: `{"ok": true, "extracted": N, ...}`

## Catch-up without redeploying

GitHub → Actions → **Catch-up Articles** → Run workflow (processes up to 25 missed articles per run).

Run multiple times until the queue is empty.