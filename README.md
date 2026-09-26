# open-ticket

An AI-powered movie ticket stub generator. Enter a film title and a showtime and you get back a commemorative, collectible cinema ticket stub: a minimalist, poster-grade illustration of the film's single most iconic motif, with the title, showtime and a random seat number typeset onto the ticket, plus fine print carrying the premiere year and an iconic line of dialogue.

**Live demo:** https://tickets.openclawd.co

## Features

- **Iconic-motif illustration** — a prompt-rewrite model distills each film into one instantly recognizable, flat geometric motif (never photorealistic, never a crowded scene roster).
- **Verbatim typography** — the film title and showtime are injected into the image prompt character-for-character by the worker; the LLM is never trusted to transcribe them (long CJK titles garble easily).
- **Fact fine print** — premiere year + one iconic quote, extracted via built-in web search (covers unreleased / newly released / obscure films), strictly sanitized ("better empty than wrong"), rendered as small italics above the barcode. Optional manual overrides.
- **Random seat + barcode** — every stub gets a random seat (row A–L, skipping I) and a decorative random-width barcode.
- **Bilingual UI (zh/en)** and **light/dark themes**, both persisted in localStorage.
- **Vintage editorial design** — warm paper, film grain, serif-led ticket typography, zero emoji (see [DESIGN.md](DESIGN.md)).
- **Abuse resistance** — trusted anonymous sessions bootstrapped via Cloudflare Turnstile with a proof-of-work fallback, a per-session daily quota (strongly consistent, transactionally pre-deducted in Durable Object storage), and a short IP burst limit.
- **Streaming progress** — SSE queue/generation events, with a poll fallback backed by a KV task cache.

## Architecture

| Layer | Tech |
| --- | --- |
| Frontend | Vite + React 18 + TypeScript; single CSS entry (`src/index.css`), no UI framework |
| Backend | Cloudflare Worker (TypeScript) |
| Queue | Durable Object (SQLite storage class) — in-memory task queue + transactional quota accounting |
| Cache / rate limiting | Cloudflare KV — IP burst counters + task state cache for the poll fallback |
| AI | LLM gateway proxy — any OpenAI-compatible gateway: chat completions for the prompt rewrite, image generation for the ticket art |
| Anti-abuse | Cloudflare Turnstile + SHA-256 proof-of-work bootstrap → HMAC-signed anonymous session cookie |

### Data flow

1. The frontend establishes a trusted anonymous session once (invisible managed Turnstile for low-risk visitors; PoW fallback otherwise) and receives an HMAC-signed HttpOnly cookie.
2. `POST /api/generate` carries title + showtime (+ optional year/quote overrides). The worker verifies the session, applies the IP burst limit, and forwards the task to a singleton Durable Object.
3. The DO pre-deducts the session's daily quota inside a storage transaction, enqueues the task, and streams SSE events (`queued` → `generating` → `complete` / `error`).
4. Per task the DO calls the gateway twice: a structured prompt-rewrite chat completion (illustration / layout / palette + year / quote fact fields, web search on, JSON output), then an image generation call whose prompt embeds the user's title / showtime / seat verbatim.
5. The finished image URL is streamed to the client and cached in KV (5-minute TTL) so a reload can still poll `GET /api/task/:id` even after DO eviction.
6. Generation failures and queue timeouts refund the pre-deducted quota.

## Local development

Prerequisites: Node.js ≥ 20.

```bash
npm install                  # frontend deps
cd worker && npm install     # worker deps (wrangler, workers-types)
```

Run the worker (listens on `:8787`):

```bash
cd worker
# fill in your KV namespace id in wrangler.toml first (see Self-hosting)
printf 'LLM_SERVICE_TOKEN=<gateway-token>\nTURNSTILE_SECRET=<turnstile-secret>\n' > .dev.vars
npx wrangler dev
```

Run the frontend — the vite dev server proxies `/api` to `http://localhost:8787`:

```bash
npm run dev
```

In dev the frontend always calls `/api` through the proxy; no production API base is baked into the bundle.

## Self-hosting

1. **KV namespace** — run `wrangler kv namespace create RATE_LIMIT` and put the returned id into `worker/wrangler.toml`.
2. **Durable Object** — the SQLite-class migration is already declared in `worker/wrangler.toml`; nothing extra to do.
3. **Secrets** — `wrangler secret put LLM_SERVICE_TOKEN` (bearer token for your LLM gateway) and `wrangler secret put TURNSTILE_SECRET` (your Cloudflare Turnstile site secret; also used as the HMAC key material for session signing).
4. **LLM gateway** — set `LLM_GATEWAY_URL` in `worker/wrangler.toml` to any OpenAI-compatible gateway. The worker calls `POST {LLM_GATEWAY_URL}/v1/chat/completions` and `POST {LLM_GATEWAY_URL}/v1/images/generations` with an `Authorization: Bearer <LLM_SERVICE_TOKEN>` header plus an `x-llm-usecase` tag (`tickets-prompt` / `tickets-image`). The chat request is OpenAI-shaped (with the DashScope-native `enable_thinking` / `enable_search` fields); the image request uses the DashScope multimodal-generation body shape (`input.messages` + `parameters`). Default models are `qwen3.8-max` (prompt rewrite) and `qwen-image-3.0-pro` (image); a gateway may reroute them.
5. **Routing** — point `public/_redirects` at your own Worker URL (or serve the API under `/api` on the same domain), and uncomment the `routes` block in `worker/wrangler.toml` for your domain.
6. **Optional frontend env overrides** — `VITE_API_BASE` (production API base URL) and `VITE_TURNSTILE_SITE_KEY` (your own Turnstile widget key), both read at build time.
7. **Deploy** — `npm run build` and publish `dist/` to any static host; `cd worker && npx wrangler deploy` for the API.

## Tests

Snapshot guards over the worker source (prompt-assembly decisions + session/quota gates), run from the repository root:

```bash
node --test worker/test/ticket-prompt.test.mjs worker/test/session-gate.test.mjs
```

The build also runs two lints: `npm run check:dist` (production dist sanity) and `npm run check:emoji` (no Unicode emoji in UI/copy).

## License

MIT — see [LICENSE](LICENSE).
