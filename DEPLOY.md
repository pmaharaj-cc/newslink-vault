# Deploy Cloudflare Worker

The live worker URL: `https://newslink-vault.proger-yung.workers.dev`

## Prerequisites

- Cloudflare API token with Workers edit permission
- Secrets already set in Cloudflare dashboard: `GROQ_API_KEY`, `GITHUB_TOKEN`, `TRIGGER_SECRET`

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