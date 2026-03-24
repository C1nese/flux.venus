# flux.venus

This project was refactored for Vercel serverless deployment.

## Why the old version failed on Vercel

The original repository used a long-lived Node.js process that:

- kept a permanent BSC WebSocket connection open
- held SSE clients and event history in process memory
- depended on `app.listen()` and never-ending listeners

That works on a VPS, but it conflicts with Vercel Functions, which are request-driven and stateless.

## New architecture

- `index.html`: static dashboard
- `api/webhook.js`: receives contract events from a webhook provider
- `api/state.js`: returns current dashboard state
- `api/health.js`: lightweight health check
- `lib/storage.js`: stores event history and stats in Redis-compatible REST storage

The frontend now polls `/api/state` instead of opening an SSE stream.

## Required environment variables

- `WEBHOOK_SECRET`: shared secret used by your webhook provider
- `KV_REST_API_URL` or `UPSTASH_REDIS_REST_URL`: Redis REST URL
- `KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_TOKEN`: Redis REST token

Optional:

- `USDC_CONTRACT_ADDRESS`
- `FUSDT_CONTRACT_ADDRESS`
- `TOKEN_DECIMALS` default `18`
- `MAX_HISTORY` default `200`
- `ALLOW_MEMORY_FALLBACK=true` for local development only

## Expected webhook shape

The easiest payload is:

```json
{
  "source": "alchemy",
  "events": [
    {
      "tokenType": "USDC",
      "eventType": "Deposit",
      "address": "0xowner",
      "amount": "12.34",
      "shares": "12.34",
      "txHash": "0x123",
      "blockNumber": 12345678,
      "timestamp": "2026-03-24T10:00:00Z"
    }
  ]
}
```

The normalizer also tries to accept common `args`, `returnValues`, and `logs` shapes, but webhook providers vary. If your provider sends a custom structure, adjust `lib/normalize.js` to match it exactly.

## Local development

```bash
npm install
npm start
```

Local mode serves the static page and the same `/api/*` routes as Vercel.
