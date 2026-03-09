# Symsearch API — Developer Docs

> Self-hosted AI research engine. Aggregates 70+ search engines, synthesizes with LLM. Built for field service SaaS.

**Base URL:** `http://46.225.28.233:8889`  
**Auth:** `X-Research-Key: YOUR_KEY` header on all `/api/research` requests

---

## Get an API Key

```bash
curl -X POST https://46.225.28.233:8889/api/keys/generate \
  -H "Content-Type: application/json" \
  -d '{"email":"you@company.com","tier_name":"free","label":"My App"}'
```

**Response:**
```json
{
  "key": "SYM_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "tier": { "name": "free", "queries_per_hour": 10, "queries_per_month": 1000 },
  "label": "My App",
  "note": "Save this key — it will not be shown again."
}
```

> ⚠️ The raw key is only returned once. Store it securely.

---

## Pricing

| Tier       | Queries/hr | Queries/mo | Price     |
|------------|-----------|-----------|-----------|
| Free       | 10        | 1,000     | $0        |
| Starter    | 100       | 10,000    | $1/mo     |
| Pro        | 500       | 100,000   | $5/mo     |
| Enterprise | 5,000     | 1,000,000 | $20/mo    |

**vs. Brave Search API:** $5/1,000 → Symsearch at $1/10,000 = **50x cheaper**

---

## Endpoints

### POST /api/research

Standard JSON response. Full answer + sources + related queries.

```bash
curl -X POST http://46.225.28.233:8889/api/research \
  -H "Content-Type: application/json" \
  -H "X-Research-Key: YOUR_KEY" \
  -d '{
    "query": "HVAC service call pricing Houston Texas",
    "role": "owner",
    "mode": "business"
  }'
```

**Body params:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | ✅ | The search query |
| `role` | string | — | `owner` / `dispatcher` / `tech` (default: `owner`) |
| `mode` | string | — | `technical` / `business` / `compliance` / `general`. Auto-detected if omitted. |
| `lane` | string | — | `customer` by default. `bot` is only honored for privileged internal tiers. |

**Response:**
```json
{
  "answer": "Based on current market data...",
  "sources": [
    { "title": "...", "url": "...", "snippet": "...", "relevance": 0.95 }
  ],
  "confidence": 0.87,
  "relatedQueries": ["...", "...", "..."],
  "chained": false,
  "intent": "pricing",
  "lane": "customer"
}
```

> **Intent auto-detection:** If `mode` is omitted, the API detects intent from the query. "error code E5" → `technical`. "how much should I charge" → `business`. "HVAC permit Texas" → `compliance`.

> **Query chaining:** If initial results are weak (confidence < 0.6), the API silently fires a refined follow-up search, merges results, and re-synthesizes. The response `chained: true` indicates this happened.

> **Response headers:** `X-SymSearch-Lane`, `X-SymSearch-Intent`, `X-SymSearch-Cache`, `X-SymSearch-Deduped`, and `X-SymSearch-Chained` are returned on `/api/research`.

---

### POST /api/research/stream

Same as above but streams the answer token-by-token via **Server-Sent Events (SSE)**.

```javascript
const response = await fetch('http://46.225.28.233:8889/api/research/stream', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Research-Key': 'YOUR_KEY',
  },
  body: JSON.stringify({ query: 'HVAC maintenance pricing', role: 'owner' }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const text = decoder.decode(value);
  const lines = text.split('\n').filter(l => l.trim());
  
  for (const line of lines) {
    if (line.startsWith('event: ')) continue;
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      // Handle events...
    }
  }
}
```

**SSE Event stream:**
| Event | Payload | Description |
|-------|---------|-------------|
| `status` | `{ stage, message }` | `"searching"` → `"refining"` → `"synthesizing"` |
| `sources` | `{ sources: [...] }` | Sources arrive before the answer starts |
| `token` | `{ token }` | Answer text, one token at a time |
| `done` | `{ confidence, relatedQueries }` | Stream complete |
| `error` | `{ message }` | Something went wrong |

---

### GET /api/analytics

Returns aggregate stats plus recent search telemetry.

```bash
curl http://46.225.28.233:8889/api/analytics \
  -H "X-Research-Key: YOUR_KEY"
```

**Response:**
```json
{
  "analytics": {
    "total": 42,
    "avgConf": "0.89",
    "avgMs": 2340,
    "byMode": { "technical": 18, "business": 15, "general": 9 }
  },
  "telemetry": {
    "cacheHitRate": 0.42,
    "dedupeRate": 0.08,
    "chainedRate": 0.17,
    "byLane": { "customer": 30, "bot": 12 }
  }
}
```

---

### GET /api/telemetry

Returns recent in-memory platform telemetry for internal debugging.

```bash
curl http://46.225.28.233:8889/api/telemetry \
  -H "X-Research-Key: YOUR_KEY"
```

---

### GET /api/keys?email=you@co.com

List your API keys and usage.

```bash
curl "http://46.225.28.233:8889/api/keys?email=you@company.com"
```

---

### DELETE /api/keys/:id

Revoke a key.

```bash
curl -X DELETE http://46.225.28.233:8889/api/keys/KEY_UUID \
  -H "Content-Type: application/json" \
  -d '{"email":"you@company.com"}'
```

---

## HVAC-Specific Roles

The `role` parameter tunes the synthesis prompt for your user type:

| Role | Focus |
|------|-------|
| `owner` | Competitor pricing, market intel, business strategy, profit margins |
| `dispatcher` | Scheduling best practices, pricing guides, route optimization |
| `tech` | Troubleshooting, equipment manuals, refrigerant handling, diagnostic procedures |

---

## Error Codes

| Status | Meaning |
|--------|---------|
| 403 | Missing or invalid API key |
| 429 | Rate limit exceeded. Check `X-RateLimit-Remaining` header + `Retry-After` |
| 400 | Missing required params |
| 500 | Server error (SearXNG or synthesis failure) |

---

## Rate Limit Headers

Every response includes:
```
X-RateLimit-Remaining: 490
```

On 429, the body includes `retryAfter` (seconds until reset).

---

## Environment

Use `.env.example` as the baseline. The runtime variables that matter are:

- `RESEARCH_INTERNAL_KEY`
- `SEARXNG_URL`
- `SEARXNG_KEY`
- `GROQ_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `STRIPE_SECRET_KEY`
- `PRICE_STARTER`
- `PRICE_PRO`
- `PRICE_ENTERPRISE`

*Built by the Sym team. Powered by SearXNG + Groq.*
