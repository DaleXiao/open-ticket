// open-ticket — movie ticket stub generator worker
// Given a film title + showtime, generates a commemorative ticket stub image
// (the title/showtime text is written into the image by the model itself).
//
// Architecture:
//   - all LLM calls go through the configured gateway (LLM_GATEWAY_URL), tagged with an x-llm-usecase header
//   - async queue: Durable Object + SSE streaming + KV task cache (poll fallback)
//   - rate limiting: trusted-session daily quota (bootstrapped via Turnstile/PoW) + short IP burst limit

export interface Env {
  RATE_LIMIT: KVNamespace;
  // Bearer token for the LLM gateway (set via `wrangler secret put LLM_SERVICE_TOKEN`).
  LLM_SERVICE_TOKEN: string;
  LLM_GATEWAY_URL: string;
  ENVIRONMENT: string;
  GENERATION_QUEUE: DurableObjectNamespace;
  // Cloudflare Turnstile site secret (set via `wrangler secret put TURNSTILE_SECRET`).
  TURNSTILE_SECRET?: string;
}

// --- Types ---

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  enable_thinking?: boolean;
  // Web search: covers training-knowledge gaps for new/upcoming/obscure films.
  // Native DashScope compatible-mode parameter; the gateway passes the body through byte-for-byte (only the model may be rerouted), so no gateway changes are needed.
  enable_search?: boolean;
  response_format?: { type: string };
  [key: string]: unknown;
}

interface ChatResponse {
  choices: Array<{ message: { content: string } }>;
}

// Structured model output: only the three narrative slots (illustration + layout + palette);
// the title and showtime strings are injected verbatim by the worker — the LLM is never
// trusted to transcribe them (long CJK titles carry a high garbling risk).
// v1.6 added two fact slots (year/quote): extracted via web search, sanitized by the worker, injected verbatim.
interface TicketPrompt {
  illustration: string; // abstract illustration description
  layout: string;       // layout instructions (relative positions of art/text fields)
  palette: string;      // color palette + mood
  year?: string;        // premiere year (4 digits; empty string when not found)
  quote?: string;       // iconic line (short verbatim quote; empty string when none is widely known)
}

interface QueueTask {
  taskId: string;
  title: string;
  showtime: string;
  seat: string;
  // v1.6: optional user-provided overrides; otherwise filled in automatically via web search.
  year?: string;
  quote?: string;
  ip: string;
  sessionId?: string;
  isTestMode: boolean;
  testRemaining?: number;
  // v1.6.1: quota remaining after the pre-deduction at enqueue time (sent to the client with the complete event).
  reservedRemaining?: number;
  promptModel: string;
  status: "queued" | "generating" | "complete" | "error";
  // One stub per task; the icons[] array shape is kept for the SSE event contract (index is always 0).
  icons: Array<{ url: string; index: number }>;
  remaining?: number;
  errorMessage?: string;
  createdAt: number;
  currentIconIndex?: number;
}

interface SSEWriter {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  taskId: string;
}

type TrustedSession = { sid: string; exp: number };

type PowPayload = { nonce: string; exp: number; ipTag: string };

// --- Constants ---

// Free to use; per-session daily quota. The threshold has been 10 since the MVP.
const DAILY_LIMIT = 10;
// ?test mode is for true end-to-end tests, with its own cap on paid output.
const TEST_DAILY_IMAGE_LIMIT = 100;
const TEST_IMAGES_PER_TASK = 1;

const PROMPT_MODEL = "qwen3.8-max"; // default; the gateway may hot-reroute models
const IMAGE_MODEL = "qwen-image-3.0-pro"; // default image model

// Gateway endpoints (pass-through to DashScope; the upstream response schema is unchanged, so parsing needs no adaptation).
const CHAT_PATH = "/v1/chat/completions";
const IMAGE_PATH = "/v1/images/generations";

// Ticket stub is landscape 3:2; 1536*1024 is the recommended size.
const TICKET_SIZE = "1536*1024";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://tickets.openclawd.co",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_QUEUE_SIZE = 10;
// Prompt rewrite + image generation can each legitimately take ~2min; this is the end-to-end queue budget.
const TASK_TIMEOUT_MS = 420_000;

// Origin allowlist — only these frontends may call the write endpoints (the read-only quota endpoint stays open).
const ALLOWED_ORIGINS = new Set<string>([
  "https://tickets.openclawd.co",
  "https://www.openclawd.co",
  "https://openclawd.co",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
]);

const BURST_WINDOW_SECONDS = 60;
const BURST_LIMIT = 5;

// Trusted anonymous session (Turnstile + PoW bootstrap).
const SESSION_COOKIE = "trusted_session";
const SESSION_CONTEXT = "trusted-session-v1";
const POW_CONTEXT = "pow-challenge-v1";
const POW_DIFFICULTY = 16;
const POW_TTL_MS = 2 * 60_000;
const POW_COUNTER_MAX = 4_194_304;

// Poll-fallback cache TTL.
const TASK_CACHE_TTL_SECONDS = 300;

function taskCacheKey(taskId: string): string {
  return `task:${taskId}`;
}

// --- Prompt-rewrite system prompt ---
//
// Core principle: the model distills the film's single most recognizable scene/element
// from its own film knowledge into an abstract illustration description + layout
// instructions + palette. The model NEVER writes the title/showtime body text itself —
// those two strings are injected verbatim from the user's input by the worker
// (avoids the garbling risk of long CJK titles — a key design decision).

export const TICKET_SYSTEM_PROMPT = `You are an elite movie-ticket art director. Given a film title (any language) and a showtime, you produce a single structured JSON interpretation that an image model renders as a commemorative, collectible cinema ticket stub.

━━━ CORE PRINCIPLE ━━━
The illustration must evoke the film through its SINGLE most iconic, recognizable element or motif — rendered as a flat, geometric, minimalist poster-grade graphic whose silhouette is instantly recognizable, never a photorealistic still and never a specific actor's likeness. Rely on your own knowledge of the film. If web-search results are available for this film, prefer the freshest public material (posters, stills, production reports) as the motif source over your training memory — an unreleased or newly released film has no reliable training data.

━━━ RULES ━━━
1. ICONIC BUT RECOGNIZABLE — render the film's single most recognizable motif as a flat, bold graphic silhouette that a viewer can name the film from at a glance (the DeLorean's gull-wing stance for "Back to the Future", the black monolith for "2001: A Space Odyssey", the red balloon for "IT", a lone shark fin above water for "Jaws"). Keep the silhouette TRUE to the real object — its signature shape and proportions must stay accurate — but rendered flat and simplified. ONE motif only.
2. SIMPLEST POSSIBLE — 1 dominant motif, at most 1 supporting shape. Flat solid fills, no gradients, no texture detail, no depth. Large negative space around the motif. Abstract in style, accurate in silhouette, instantly nameable. Crowded or busy tickets look cheap and AI-generated.
3. MINIMALIST POSTER-GRADE — think a 1950s–70s minimalist film poster: a single bold geometric shape against empty field, not a populated scene. Never enumerate a roster of scenes or objects; never stack decorative detail.
4. TWO TO THREE COLORS — a tight, disciplined palette (2–3 ink colors + the paper). The palette must match the film's emotional register (noir = near-black + one warm accent; comedy = warm cream + one bright; horror = near-black + one blood accent).
5. NEVER WRITE TEXT — your JSON describes ILLUSTRATION + LAYOUT + PALETTE only. The system injects the film title and showtime strings separately as exact text. You must NOT reproduce or transliterate them. Since v1.6 the JSON additionally carries two FACT fields (year, quote) defined below; the system renders them as tiny fine print — never weave the year or quote into the illustration/layout/palette descriptions.

━━━ FACT FIELDS (v1.6) ━━━
Besides the visual slots, output two factual fields that the system renders as tiny fine-print text near the barcode:
- "year": the film's original theatrical PREMIERE YEAR as a 4-digit year string (e.g. "2000"). Use web-search results when available — verify against release records rather than memory. If the film is unreleased, or the year cannot be established with confidence, output "".
- "quote": ONE iconic, widely-known line of dialogue FROM the film, in the film's original language, kept extremely short — at most 10 Chinese characters (or at most ~8 words for alphabetic languages). Quote it verbatim as it is commonly cited; never paraphrase, never invent. If the film has no widely-known signature line, output "".
These two fields are DATA, not illustration content: never weave the year or quote into the illustration/layout/palette descriptions.

━━━ OUTPUT FORMAT ━━━
Output ONLY valid JSON (no markdown fences, no commentary):
{
  "illustration": "abstract graphic description: the single iconic motif, concrete flat shapes, composition (2-3 sentences max)",
  "layout": "where the illustration sits on the ticket relative to the text block (e.g. a left flat motif with the typeset title+time on the right; or a large background motif with a reserved bottom text strip)",
  "palette": "2-3 concrete colors named as hex-like descriptions + the single mood word they create",
  "year": "4-digit premiere year, or empty string",
  "quote": "one iconic short line from the film in its original language, or empty string"
}`;

// --- v1.6 fact-field sanitization (premiere year / iconic quote) ---
// Principle: better empty than wrong. Invalid = dropped; the ticket falls back to the classic four-line layout.

// Premiere year: 4 digits only, within cinema-history range (1888–2035).
function sanitizeYear(raw: unknown): string | undefined {
  const y = String(raw ?? "").trim();
  if (!/^\d{4}$/.test(y)) return undefined;
  const n = parseInt(y, 10);
  return n >= 1888 && n <= 2035 ? y : undefined;
}

// Quote length caps: CJK ≤10 characters; Latin ≤60 characters (≈8 words).
const QUOTE_MAX_CJK = 10;
const QUOTE_MAX_LATIN = 60;

function sanitizeQuote(raw: unknown): string | undefined {
  const q = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!q) return undefined;
  const hasCJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/.test(q);
  const max = hasCJK ? QUOTE_MAX_CJK : QUOTE_MAX_LATIN;
  if ([...q].length > max) return undefined;
  return q;
}

export function assembleTicketPrompt(title: string, showtime: string, seat: string, p: TicketPrompt): string {
  // v1.6 fine-print line: premiere year + iconic quote, small italics just above the barcode.
  const year = sanitizeYear(p.year);
  const quote = sanitizeQuote(p.quote);
  const finePrint = year && quote ? `首映 ${year} · ${quote}` : year ? `首映 ${year}` : quote;

  const lineCountLine = finePrint
    ? "The ticket carries EXACTLY FIVE lines of typeset text and nothing else."
    : "The ticket carries EXACTLY FOUR lines of typeset text and nothing else.";

  const finePrintLine = finePrint
    ? `Line 5 — the fine-print line, typeset NOTICEABLY SMALLER than every other line, in gentle italic with faint ink, sitting directly above the barcode strip at the very bottom, clearly de-emphasized like a printed footnote: "${finePrint}"`
    : null;

  const hierarchyLine = finePrint
    ? "Typeset all five lines with elegant editorial hierarchy: title largest, showtime clearly smaller, seat number small and discreet, cinema name in wide letter-spaced small-caps, and the fine-print line smallest and faintest of all — it must not compete with the title or showtime for attention. Lines 1-4 share one alignment axis (either all left-aligned, or all centered); line 5 sits alone just above the barcode. The typesetting must read like a refined print ticket, not label stickers."
    : "Typeset all four lines with elegant editorial hierarchy: title largest, showtime clearly smaller, cinema name smallest with wide letter-spacing, seat number small and discreet near the bottom. All text lines share one alignment axis (either all left-aligned, or all centered). The typesetting must read like a refined print ticket, not label stickers.";

  const onlyTextLine = finePrint
    ? "Do NOT render any field-label words (no 'Film title', no 'Showtime', no 'ADMIT ONE', no 'SEAT'). Do NOT invent any extra text — no price, no venue name other than ELSEWHERE CINEMA, no date sub-fields, no pseudo-Latin filler, no invented words, no signage. The ONLY readable text on the entire ticket is the five lines above."
    : "Do NOT render any field-label words (no 'Film title', no 'Showtime', no 'ADMIT ONE', no 'SEAT'). Do NOT invent any extra text — no price, no venue name other than ELSEWHERE CINEMA, no date sub-fields, no pseudo-Latin filler, no invented words, no signage. The ONLY readable text on the entire ticket is the four lines above.";

  return [
    "A flat, graphic, minimalist poster-grade cinema ticket stub illustration, landscape 3:2, printed on warm cream ticket stock with subtle paper-fiber texture and a clean perforated-edge silhouette (a row of small notches on one short side).",
    p.illustration,
    p.layout,
    p.palette,
    "",
    lineCountLine,
    `Line 1 — the film title, typeset large and elegant in an editorial Didone/Garamond serif, on its own line: "${title}"`,
    `Line 2 — the showtime, typeset smaller beneath the title in the same serif, sharing the title's left (or center) alignment axis and clearly subordinated: "${showtime}"`,
    `Line 3 — below both, small and letter-spaced uppercase small-caps, the fixed cinema name: "ELSEWHERE CINEMA"`,
    `Line 4 — the seat number, small and elegant, in a reserved bottom area, typeset in the same serif and letter-spaced, sharing the same alignment axis: "${seat}"`,
    ...(finePrintLine ? [finePrintLine] : []),
    hierarchyLine,
    "The entire text block must sit on a clean, unobstructed, plain background area — never overlapping the illustration, the perforation notches, the barcode, or any graphic element. Reserve a dedicated plain band for the typeset lines.",
    onlyTextLine,
    "No emoji, no pictographic or emoticon symbols anywhere on the ticket.",
    "",
    "Along the bottom edge, render a single thin horizontal barcode strip with irregular, random-width vertical black bars (a real ticket stub's barcode). The barcode is decorative: it decodes to no readable characters and contains no text.",
    "Chinese / Japanese / Korean characters in the text lines must be rendered with complete, correct strokes — never simplified, broken, mirrored, or replaced with look-alike glyphs. Numbers, colons, hyphens, punctuation and the seat number must match exactly, character-for-character.",
    "No watermark, no signature, no artist credit.",
  ].join("\n");
}

// --- Helpers ---

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function getClientIP(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function getCount(kv: KVNamespace, key: string): Promise<number> {
  const raw = await kv.get(key);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

// --- Per-session daily quota ---
// v1.6.1: the counter moved from KV into Durable Object storage.
// Root cause: KV is eventually consistent (~60s propagation), so the entry pre-check at
// the worker layer could read a stale value, letting rapid clicks squeeze past an
// exhausted quota (observed: one session reached 12 against a limit of 10).
// DO storage is strongly consistent + transactional: pre-deduct before enqueue, refund on failure (same mechanism as reserveTestImages).

function sessionQuotaKey(sid: string, now = new Date()): string {
  return `session-limit:${sid}:${now.toISOString().slice(0, 10)}`;
}

function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

async function checkBurst(kv: KVNamespace, ip: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  const key = `burst:${ip}:${Math.floor(Date.now() / (BURST_WINDOW_SECONDS * 1000))}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= BURST_LIMIT) {
    return { allowed: false, retryAfter: BURST_WINDOW_SECONDS };
  }
  try {
    await kv.put(key, String(count + 1), { expirationTtl: BURST_WINDOW_SECONDS * 2 });
  } catch (e) {
    console.warn("[burst] KV put failed (quota?), allowing through:", (e as Error)?.message);
  }
  return { allowed: true };
}

// --- Trusted anonymous session (Turnstile + PoW bootstrap) ---

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

async function issueTrustedSession(secret: string): Promise<{ value: string; session: TrustedSession }> {
  const now = Date.now();
  const nextUtcDay = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
  const session: TrustedSession = { sid: crypto.randomUUID(), exp: Math.min(now + 86_400_000, nextUtcDay) };
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(session)));
  const message = new TextEncoder().encode(`${SESSION_CONTEXT}.${payload}`);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await sessionKey(secret), message));
  return { value: `${payload}.${base64Url(signature)}`, session };
}

async function verifyTrustedSession(request: Request, secret?: string): Promise<TrustedSession | null> {
  if (!secret) return null;
  const raw = request.headers.get("Cookie")?.split(";").map((v) => v.trim())
    .find((v) => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return null;
  const [payload, signature, extra] = raw.split(".");
  if (!payload || !signature || extra) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC", await sessionKey(secret), fromBase64Url(signature),
      new TextEncoder().encode(`${SESSION_CONTEXT}.${payload}`)
    );
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as TrustedSession;
    if (!parsed.sid || !Number.isFinite(parsed.exp) || parsed.exp <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function hmacValue(secret: string, context: string, payload: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.sign(
    "HMAC", await sessionKey(secret), new TextEncoder().encode(`${context}.${payload}`)
  ));
  return base64Url(bytes);
}

async function ipTag(secret: string, ip: string): Promise<string> {
  return (await hmacValue(secret, "pow-ip-v1", ip)).slice(0, 16);
}

function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) if (bytes[i] !== 0) return false;
  const remainder = bits % 8;
  return remainder === 0 || (bytes[full] & (0xff << (8 - remainder))) === 0;
}

async function verifyPow(request: Request, env: Env, challenge: string, counter: number): Promise<boolean> {
  if (!env.TURNSTILE_SECRET || !Number.isSafeInteger(counter) || counter < 0 || counter > POW_COUNTER_MAX) return false;
  const [encoded, signature, extra] = challenge.split(".");
  if (!encoded || !signature || extra) return false;
  const expected = await hmacValue(env.TURNSTILE_SECRET, POW_CONTEXT, encoded);
  if (expected.length !== signature.length) return false;
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (different !== 0) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as PowPayload;
    if (!payload.nonce || payload.exp < Date.now() || payload.exp > Date.now() + POW_TTL_MS + 5_000) return false;
    if (payload.ipTag !== await ipTag(env.TURNSTILE_SECRET, getClientIP(request))) return false;
    const replayKey = `pow-used:${payload.nonce}`;
    if (await env.RATE_LIMIT.get(replayKey)) return false;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${challenge}:${counter}`)));
    if (!hasLeadingZeroBits(digest, POW_DIFFICULTY)) return false;
    await env.RATE_LIMIT.put(replayKey, "1", { expirationTtl: 180 });
    return true;
  } catch {
    return false;
  }
}

async function verifyTurnstile(token: string, env: Env, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return false;
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    const data = (await res.json()) as { success?: boolean };
    return !!data.success;
  } catch {
    return false;
  }
}

async function issuePowChallenge(request: Request, env: Env): Promise<Response> {
  if (!env.TURNSTILE_SECRET) return jsonResponse({ error: "verification_unavailable" }, 503);
  const payload: PowPayload = {
    nonce: crypto.randomUUID(),
    exp: Date.now() + POW_TTL_MS,
    ipTag: await ipTag(env.TURNSTILE_SECRET, getClientIP(request)),
  };
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacValue(env.TURNSTILE_SECRET, POW_CONTEXT, encoded);
  return jsonResponse({ challenge: `${encoded}.${signature}`, difficulty: POW_DIFFICULTY }, 200);
}

async function handleSessionBootstrap(request: Request, env: Env): Promise<Response> {
  let body: { turnstileToken?: string; powChallenge?: string; powCounter?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid_input", message: "无效的验证请求" }, 400);
  }
  const ip = getClientIP(request);
  const turnstileOk = !!body.turnstileToken && await verifyTurnstile(body.turnstileToken, env, ip);
  const powOk = !!body.powChallenge && await verifyPow(request, env, body.powChallenge, Number(body.powCounter));
  if ((!turnstileOk && !powOk) || !env.TURNSTILE_SECRET) {
    return jsonResponse({ error: "verification_failed", message: "安全验证未通过，请重试" }, 403);
  }
  const { value, session } = await issueTrustedSession(env.TURNSTILE_SECRET);
  const maxAge = Math.max(1, Math.floor((session.exp - Date.now()) / 1000));
  return new Response(JSON.stringify({ ok: true, expiresAt: session.exp }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/api; HttpOnly; Secure; SameSite=Strict`,
      ...CORS_HEADERS,
    },
  });
}

// --- Prompt rewrite ---

async function synthesizeTicketPrompt(
  title: string,
  showtime: string,
  seat: string,
  apiKey: string,
  gatewayUrl: string,
  model: string = PROMPT_MODEL,
  // v1.6: user-provided year/quote overrides (already sanitized in handleGenerate); otherwise filled via web search.
  overrides?: { year?: string; quote?: string }
): Promise<string> {
  const requestBody: ChatRequest = {
    model,
    temperature: 0.8,
    // Structured rewrite, not a reasoning task — keep thinking off to stay clear of the upstream 125s edge limit (observed in practice).
    enable_thinking: false,
    // Web search on by default: covers knowledge gaps for unreleased / newly released / obscure films.
    enable_search: true,
    messages: [
      { role: "system", content: TICKET_SYSTEM_PROMPT },
      { role: "user", content: `Film title: ${title}\nShowtime: ${showtime}` },
    ],
  };

  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(`${gatewayUrl}${CHAT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-llm-usecase": "tickets-prompt",
      },
      body: JSON.stringify(requestBody),
    });

    if (response.status === 401) {
      const errBody = await response.text();
      console.error(`[llm-gateway] unauthorized on chat: ${errBody}`);
      throw new Error(`LLM gateway unauthorized: ${errBody}`);
    }
    if (response.status === 429 && attempt < 2) {
      const delay = Math.min(5000 * Math.pow(2, attempt), 20000);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    break;
  }

  if (!response || !response.ok) {
    const errorText = response ? await response.text() : "No response";
    throw new Error(`LLM gateway chat error (${response?.status}): ${errorText}`);
  }

  const data = (await response.json()) as ChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("chat API returned empty content");

  let parsed: TicketPrompt;
  try {
    let cleaned = content.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    parsed = JSON.parse(cleaned) as TicketPrompt;
  } catch {
    throw new Error(`Failed to parse ticket prompt response as JSON: ${content}`);
  }

  if (!parsed?.illustration || !parsed?.layout || !parsed?.palette) {
    throw new Error(`ticket prompt response missing fields: ${JSON.stringify(parsed)}`);
  }

  // User overrides win over search results (already sanitized; assembleTicketPrompt sanitizes again and falls back when invalid).
  if (overrides?.year !== undefined) parsed.year = overrides.year;
  if (overrides?.quote !== undefined) parsed.quote = overrides.quote;

  return assembleTicketPrompt(title, showtime, seat, parsed);
}

// --- Image generation ---

async function generateTicket(
  prompt: string,
  apiKey: string,
  gatewayUrl: string,
  maxRetries = 5
): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(`${gatewayUrl}${IMAGE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-llm-usecase": "tickets-image",
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        input: {
          messages: [{ role: "user", content: [{ text: prompt }] }],
        },
        parameters: {
          size: TICKET_SIZE,
          n: 1,
          seed: Math.floor(Math.random() * 2147483647),
          // prompt_extend=false: ticket text must be verbatim-exact — upstream prompt expansion must not perturb it;
          // watermark=false: our own output, no watermark.
          prompt_extend: false,
          watermark: false,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 401) {
        console.error(`[llm-gateway] unauthorized on image: ${errorText}`);
        throw new Error(`LLM gateway unauthorized: ${errorText}`);
      }
      if ((response.status === 429 || response.status === 502 || response.status === 503) && attempt < maxRetries - 1) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`LLM gateway image error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> };
      code?: string;
      message?: string;
    };

    if (data.code) {
      if (data.code === "Throttling.RateQuota" && attempt < maxRetries - 1) {
        const delay = Math.min(5000 * Math.pow(2, attempt), 30000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`Dashscope API error: ${data.code} - ${data.message}`);
    }

    const imageUrl = data.output?.choices?.[0]?.message?.content?.[0]?.image;
    if (!imageUrl) throw new Error(`Dashscope returned no image: ${JSON.stringify(data)}`);
    return imageUrl;
  }
  throw new Error("[throttled] image generation failed after retries");
}

// --- Durable Object: GenerationQueue ---

export class GenerationQueue {
  private queue: QueueTask[] = [];
  private sseClients: Map<string, SSEWriter[]> = new Map();
  private completedTasks: Map<string, QueueTask> = new Map();
  private processing = false;
  private env: Env;
  private lastImageFinishedAt = 0;
  private static readonly IMAGE_COOLDOWN_MS = 3000;

  // DurableObjectState is kept for finer-grained persistence in the future; the current queue is in-memory + KV fallback.
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/enqueue" && request.method === "POST") return this.handleEnqueue(request);
    if (path === "/stream" && request.method === "GET") return this.handleStream(request);
    if (path === "/status" && request.method === "GET") return this.handleStatus(request);
    if (path === "/test-quota" && request.method === "GET") return this.handleTestQuota();
    if (path === "/session-quota" && request.method === "GET") return this.handleSessionQuota(request);
    return new Response("Not Found", { status: 404 });
  }

  private async handleEnqueue(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      taskId: string;
      title: string;
      showtime: string;
      seat: string;
      year?: string;
      quote?: string;
      ip: string;
      sessionId?: string;
      isTestMode: boolean;
      promptModel: string;
    };

    this.cleanupTimedOut();

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      return jsonResponse({ error: "queue_full", message: "当前使用人数较多，请 30 秒后再试", retryAfter: 30 }, 503);
    }

    let testRemaining: number | undefined;
    if (body.isTestMode) {
      const budget = await this.reserveTestImages(TEST_IMAGES_PER_TASK);
      if (!budget.allowed) {
        return jsonResponse(
          { error: "test_daily_limit", message: `测试模式每天最多生成 ${TEST_DAILY_IMAGE_LIMIT} 张图片，请明天再试`, remaining: budget.remaining, total: TEST_DAILY_IMAGE_LIMIT },
          429
        );
      }
      testRemaining = budget.remaining;
    }

    // v1.6.1: the session daily quota is pre-deducted transactionally before enqueue (strongly consistent DO storage; the old KV path is gone).
    let reservedRemaining: number | undefined;
    if (!body.isTestMode && body.sessionId) {
      const quota = await this.reserveSessionQuota(body.sessionId);
      if (!quota.allowed) {
        return jsonResponse({ error: "rate_limited", message: "今天免费额度已用完，请明天再来", remaining: 0, total: DAILY_LIMIT }, 429);
      }
      reservedRemaining = quota.remaining;
    }

    const task: QueueTask = {
      taskId: body.taskId,
      title: body.title,
      showtime: body.showtime,
      seat: body.seat,
      year: body.year,
      quote: body.quote,
      ip: body.ip,
      sessionId: body.sessionId,
      isTestMode: body.isTestMode,
      testRemaining,
      reservedRemaining,
      promptModel: body.promptModel || PROMPT_MODEL,
      status: "queued",
      icons: [],
      createdAt: Date.now(),
    };

    this.queue.push(task);
    if (!this.processing) this.processQueue();
    return jsonResponse({ taskId: task.taskId, position: this.queue.length }, 202);
  }

  private testBudgetKey(now = new Date()): string {
    return `test-images:${now.toISOString().slice(0, 10)}`;
  }

  private async reserveTestImages(count: number): Promise<{ allowed: boolean; remaining: number }> {
    const key = this.testBudgetKey();
    return this.state.storage.transaction(async (tx) => {
      const used = (await tx.get<number>(key)) ?? 0;
      if (used + count > TEST_DAILY_IMAGE_LIMIT) {
        return { allowed: false, remaining: Math.max(0, TEST_DAILY_IMAGE_LIMIT - used) };
      }
      const next = used + count;
      await tx.put(key, next);
      return { allowed: true, remaining: TEST_DAILY_IMAGE_LIMIT - next };
    });
  }

  private async handleTestQuota(): Promise<Response> {
    const used = (await this.state.storage.get<number>(this.testBudgetKey())) ?? 0;
    return jsonResponse({ remaining: Math.max(0, TEST_DAILY_IMAGE_LIMIT - used), total: TEST_DAILY_IMAGE_LIMIT });
  }

  // --- v1.6.1: session daily quota (DO storage, strongly consistent + transactional) ---

  private async reserveSessionQuota(sid: string): Promise<{ allowed: boolean; remaining: number }> {
    const key = sessionQuotaKey(sid);
    return this.state.storage.transaction(async (tx) => {
      // Also delete this session's non-today keys to keep storage from growing.
      const stale = await tx.list<string>({ prefix: `session-limit:${sid}:` });
      for (const [k] of stale) {
        if (k !== key) await tx.delete(k);
      }
      const used = (await tx.get<number>(key)) ?? 0;
      if (used >= DAILY_LIMIT) return { allowed: false, remaining: 0 };
      const next = used + 1;
      await tx.put(key, next);
      return { allowed: true, remaining: DAILY_LIMIT - next };
    });
  }

  private async refundSessionQuota(sid: string): Promise<void> {
    const key = sessionQuotaKey(sid);
    await this.state.storage.transaction(async (tx) => {
      const used = (await tx.get<number>(key)) ?? 0;
      if (used > 0) await tx.put(key, used - 1);
    });
  }

  private async handleSessionQuota(request: Request): Promise<Response> {
    const sid = new URL(request.url).searchParams.get("sid");
    if (!sid) return jsonResponse({ error: "missing_sid", message: "缺少 sid 参数" }, 400);
    const key = sessionQuotaKey(sid);
    const used = (await this.state.storage.get<number>(key)) ?? 0;
    return jsonResponse({ remaining: Math.max(0, DAILY_LIMIT - used), total: DAILY_LIMIT });
  }

  private handleStream(request: Request): Response {
    const url = new URL(request.url);
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return jsonResponse({ error: "missing_taskId", message: "缺少 taskId 参数" }, 400);

    const task = this.queue.find((t) => t.taskId === taskId) || this.completedTasks.get(taskId) || null;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const sseWriter: SSEWriter = { writer, taskId };

    if (!this.sseClients.has(taskId)) this.sseClients.set(taskId, []);
    this.sseClients.get(taskId)!.push(sseWriter);

    if (task) {
      const sendCurrentState = async () => {
        try {
          if (task.status === "queued") {
            const position = this.queue.findIndex((t) => t.taskId === taskId) + 1;
            await writer.write(encoder.encode(`event: queued\ndata: ${JSON.stringify({ position })}\n\n`));
          } else if (task.status === "generating") {
            await writer.write(encoder.encode(`event: generating\ndata: ${JSON.stringify({ index: task.currentIconIndex ?? 0, total: 1 })}\n\n`));
            for (const icon of task.icons) {
              await writer.write(encoder.encode(`event: icon_ready\ndata: ${JSON.stringify({ url: icon.url, index: icon.index })}\n\n`));
            }
          } else if (task.status === "complete") {
            for (const icon of task.icons) {
              await writer.write(encoder.encode(`event: icon_ready\ndata: ${JSON.stringify({ url: icon.url, index: icon.index })}\n\n`));
            }
            await writer.write(encoder.encode(`event: complete\ndata: ${JSON.stringify({ icons: task.icons, remaining: task.remaining })}\n\n`));
            await writer.close();
            this.removeSseClient(taskId, sseWriter);
          } else if (task.status === "error") {
            await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: task.errorMessage })}\n\n`));
            await writer.close();
            this.removeSseClient(taskId, sseWriter);
          }
        } catch {
          this.removeSseClient(taskId, sseWriter);
        }
      };
      sendCurrentState();
    } else {
      const sendNotFound = async () => {
        try {
          await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: "任务不存在或已过期" })}\n\n`));
          await writer.close();
        } catch {
          // ignore
        }
      };
      sendNotFound();
      this.removeSseClient(taskId, sseWriter);
    }

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...CORS_HEADERS,
      },
    });
  }

  private handleStatus(request: Request): Response {
    const url = new URL(request.url);
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return jsonResponse({ error: "missing_taskId", message: "缺少 taskId 参数" }, 400);

    const task = this.queue.find((t) => t.taskId === taskId) || this.completedTasks.get(taskId) || null;
    if (!task) return jsonResponse({ error: "not_found", message: "任务不存在或已过期" }, 404);

    const position = this.queue.findIndex((t) => t.taskId === taskId) + 1;
    return jsonResponse({
      taskId: task.taskId,
      status: task.status,
      position,
      icons: task.icons,
      remaining: task.remaining,
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue[0];
      if (task.status === "complete" || task.status === "error") {
        this.queue.shift();
        continue;
      }

      this.broadcastQueuePositions();

      try {
        task.status = "generating";
        task.currentIconIndex = 0;
        this.sendToTask(task.taskId, "generating", { index: 0, total: 1 });

        const prompt = await synthesizeTicketPrompt(
          task.title,
          task.showtime,
          task.seat,
          this.env.LLM_SERVICE_TOKEN,
          this.env.LLM_GATEWAY_URL,
          task.promptModel,
          { year: task.year, quote: task.quote }
        );

        await this.waitForCooldown();
        const url = await generateTicket(prompt, this.env.LLM_SERVICE_TOKEN, this.env.LLM_GATEWAY_URL);
        task.icons.push({ url, index: 0 });
        this.sendToTask(task.taskId, "icon_ready", { url, index: 0 });
        this.lastImageFinishedAt = Date.now();

        // The quota was pre-deducted transactionally at enqueue time; here we only read the post-deduction remainder.
        const remaining = task.isTestMode ? (task.testRemaining ?? 0) : (task.reservedRemaining ?? 0);
        task.remaining = remaining;

        task.status = "complete";
        this.sendToTask(task.taskId, "complete", { icons: task.icons, remaining });

        // KV fallback write (the poll fallback reads this; still queryable after DO eviction).
        try {
          await this.env.RATE_LIMIT.put(
            taskCacheKey(task.taskId),
            JSON.stringify({ state: "complete", icons: task.icons, remaining }),
            { expirationTtl: TASK_CACHE_TTL_SECONDS }
          );
        } catch (e) {
          console.warn("[cache] KV put failed:", (e as Error)?.message);
        }
      } catch (error) {
        console.error("Generation failed:", error);
        // Refund the pre-deducted quota on generation failure (never charge users for failures).
        if (!task.isTestMode && task.sessionId) {
          await this.refundSessionQuota(task.sessionId);
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        const isThrottled = errMsg.includes("Throttling") || errMsg.includes("429") || errMsg.includes("[throttled]");
        task.status = "error";
        task.errorMessage = isThrottled ? "服务器繁忙，请稍后重试" : "生成失败，请稍后重试";
        this.sendToTask(task.taskId, "error", { code: isThrottled ? "throttled" : "failed", message: task.errorMessage });
        try {
          await this.env.RATE_LIMIT.put(
            taskCacheKey(task.taskId),
            JSON.stringify({ state: "error", error: task.errorMessage }),
            { expirationTtl: TASK_CACHE_TTL_SECONDS }
          );
        } catch (e) {
          console.warn("[cache] KV put failed:", (e as Error)?.message);
        }
      }

      this.queue.shift();
      this.completedTasks.set(task.taskId, task);
      setTimeout(() => {
        this.completedTasks.delete(task.taskId);
        this.closeSseClients(task.taskId);
      }, 300000);
    }

    this.processing = false;
  }

  private async waitForCooldown(): Promise<void> {
    if (this.lastImageFinishedAt === 0) return;
    const remaining = GenerationQueue.IMAGE_COOLDOWN_MS - (Date.now() - this.lastImageFinishedAt);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  }

  private broadcastQueuePositions(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      if (task.status === "queued") this.sendToTask(task.taskId, "queued", { position: i + 1 });
    }
  }

  private sendToTask(taskId: string, event: string, data: Record<string, unknown>): void {
    const clients = this.sseClients.get(taskId);
    if (!clients || clients.length === 0) return;
    const encoder = new TextEncoder();
    const message = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const toRemove: SSEWriter[] = [];
    for (const client of clients) {
      try {
        client.writer.write(message);
      } catch {
        toRemove.push(client);
      }
    }
    for (const c of toRemove) this.removeSseClient(taskId, c);
  }

  private closeSseClients(taskId: string): void {
    const clients = this.sseClients.get(taskId);
    if (!clients) return;
    for (const c of clients) {
      try {
        c.writer.close();
      } catch {
        // already closed
      }
    }
    this.sseClients.delete(taskId);
  }

  private removeSseClient(taskId: string, client: SSEWriter): void {
    const clients = this.sseClients.get(taskId);
    if (!clients) return;
    const idx = clients.indexOf(client);
    if (idx !== -1) clients.splice(idx, 1);
    if (clients.length === 0) this.sseClients.delete(taskId);
  }

  private cleanupTimedOut(): void {
    const now = Date.now();
    this.queue = this.queue.filter((task) => {
      if (now - task.createdAt > TASK_TIMEOUT_MS) {
        this.sendToTask(task.taskId, "error", { message: "任务超时，请重新提交" });
        this.closeSseClients(task.taskId);
        // Timed-out queue tasks get their pre-deducted quota refunded too.
        if (!task.isTestMode && task.sessionId) void this.refundSessionQuota(task.sessionId);
        return false;
      }
      return true;
    });
  }
}

// --- Request handlers ---

// Random seat assignment: row A–L (skipping I to avoid confusion with 1) + seat 1–20.
// Rendered per locale: EN "ROW G · SEAT 12"; ZH uses the Chinese row/seat wording.
function generateSeat(lang: string): string {
  const ROWS = "ABCDEFGHJKL";
  const row = ROWS[Math.floor(Math.random() * ROWS.length)];
  const seat = Math.floor(Math.random() * 20) + 1;
  return lang === "en" ? `ROW ${row} · SEAT ${seat}` : `${row} 排 · ${seat} 座`;
}

function generateTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  let body: { title?: string; showtime?: string; lang?: string; year?: string; quote?: string };
  try {
    body = (await request.json()) as { title?: string; showtime?: string; lang?: string; year?: string; quote?: string };
  } catch {
    return jsonResponse({ error: "invalid_input", message: "请提供有效的 JSON 请求体" }, 400);
  }

  const title = body.title?.trim();
  const showtime = body.showtime?.trim();
  const seat = generateSeat(body.lang === "en" ? "en" : "zh");
  // v1.6: user overrides are optional and sanitized at the entry point (invalid = treated as unset, falling back to web search).
  const yearOverride = sanitizeYear(body.year);
  const quoteOverride = sanitizeQuote(body.quote);
  if (!title || title.length < 1 || title.length > 120) {
    return jsonResponse({ error: "invalid_input", message: "请输入电影名（1-120 字）" }, 400);
  }
  if (!showtime || showtime.length < 5 || showtime.length > 40) {
    return jsonResponse({ error: "invalid_input", message: "请选择放映时间" }, 400);
  }

  const ip = getClientIP(request);
  const url = new URL(request.url);
  const isTestMode = url.searchParams.has("test");
  const promptModel = PROMPT_MODEL;

  let trustedSession: TrustedSession | null = null;
  if (!isTestMode) {
    // Production generation requires a server-signed anonymous session (bootstrapped once via Turnstile/PoW).
    trustedSession = await verifyTrustedSession(request, env.TURNSTILE_SECRET);
    if (!trustedSession) {
      return jsonResponse({ error: "verification_required", message: "需要完成一次安全验证" }, 403);
    }
    // The IP burst limit (5/60s) remains as a second gate.
    const burst = await checkBurst(env.RATE_LIMIT, ip);
    if (!burst.allowed) {
      return jsonResponse({ error: "rate_limited_burst", message: `请求太快，请 ${burst.retryAfter}s 后再试` }, 429);
    }
    // The 10/day session quota is pre-deducted transactionally at DO enqueue time (strongly consistent);
    // the worker layer no longer does a KV pre-check (stale eventually-consistent reads were the root cause of the over-quota bug; removed in v1.6.1).
  }

  const taskId = generateTaskId();
  const doId = env.GENERATION_QUEUE.idFromName("singleton");
  const doStub = env.GENERATION_QUEUE.get(doId);

  let doResponse: Response;
  try {
    doResponse = await doStub.fetch(
      new Request("https://do/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, title, showtime, seat, year: yearOverride, quote: quoteOverride, ip, sessionId: trustedSession?.sid, isTestMode, promptModel }),
      })
    );
  } catch (e) {
    console.error("DO enqueue failed:", (e as Error)?.message);
    return jsonResponse({ error: "service_unavailable", message: "生成服务暂时不可用，请稍后重试" }, 503);
  }

  const responseBody = await doResponse.text();
  return new Response(responseBody, {
    status: doResponse.status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function handleStream(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const taskId = url.searchParams.get("taskId");
  if (!taskId) return jsonResponse({ error: "missing_taskId", message: "缺少 taskId 参数" }, 400);

  const doId = env.GENERATION_QUEUE.idFromName("singleton");
  const doStub = env.GENERATION_QUEUE.get(doId);
  const doResponse = await doStub.fetch(new Request(`https://do/stream?taskId=${encodeURIComponent(taskId)}`, { method: "GET" }));

  return new Response(doResponse.body, {
    status: doResponse.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}

async function handleQuota(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.has("test")) {
    const doId = env.GENERATION_QUEUE.idFromName("singleton");
    return env.GENERATION_QUEUE.get(doId).fetch("https://do/test-quota");
  }
  // The quota is per session: no valid session → 403.
  const trustedSession = await verifyTrustedSession(request, env.TURNSTILE_SECRET);
  if (!trustedSession) {
    return jsonResponse({ error: "verification_required", message: "需要完成一次安全验证" }, 403);
  }
  // v1.6.1: quota counters live in DO storage (strongly consistent); queries are forwarded through the DO.
  const doId = env.GENERATION_QUEUE.idFromName("singleton");
  const doResponse = await env.GENERATION_QUEUE.get(doId).fetch(`https://do/session-quota?sid=${encodeURIComponent(trustedSession.sid)}`);
  const responseBody = await doResponse.text();
  return new Response(responseBody, {
    status: doResponse.status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function handleTaskStatus(request: Request, env: Env, taskId: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    return jsonResponse({ error: "invalid_taskId", message: "任务 ID 格式不正确" }, 400);
  }

  // Step 1: DO (in-memory queue + completed-task retention)
  const doId = env.GENERATION_QUEUE.idFromName("singleton");
  const doStub = env.GENERATION_QUEUE.get(doId);
  type DOStatus = {
    taskId: string;
    status: "queued" | "generating" | "complete" | "error";
    position: number;
    icons: Array<{ url: string; index: number }>;
    remaining?: number;
    errorMessage?: string;
  };
  let doData: DOStatus | null = null;
  try {
    const doResponse = await doStub.fetch(new Request(`https://do/status?taskId=${encodeURIComponent(taskId)}`, { method: "GET" }));
    if (doResponse.ok) doData = (await doResponse.json()) as DOStatus;
  } catch (e) {
    console.error("DO status fetch failed:", e);
  }

  if (doData && doData.taskId) {
    if (doData.status === "complete") return jsonResponse({ state: "complete", icons: doData.icons, remaining: doData.remaining });
    if (doData.status === "error") return jsonResponse({ state: "error", error: doData.errorMessage || "生成失败，请重试" });
    return jsonResponse({ state: doData.status });
  }

  // Step 2: KV fallback
  try {
    const cached = await env.RATE_LIMIT.get(taskCacheKey(taskId));
    if (cached) {
      const parsed = JSON.parse(cached) as { state: "complete" | "error"; icons?: Array<{ url: string; index: number }>; remaining?: number; error?: string };
      return jsonResponse(parsed);
    }
  } catch (e) {
    console.error("KV task cache read failed:", e);
  }

  return jsonResponse({ state: "unknown", error: "任务不存在或已过期" }, 404);
}

// --- Main Worker ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/api/pow-challenge" && request.method === "POST") {
      if (!isAllowedOrigin(request)) return jsonResponse({ error: "forbidden" }, 403);
      return issuePowChallenge(request, env);
    }

    if (path === "/api/session" && request.method === "POST") {
      if (!isAllowedOrigin(request)) {
        return jsonResponse({ error: "forbidden", message: "origin not allowed" }, 403);
      }
      return handleSessionBootstrap(request, env);
    }

    if (path === "/api/generate" && request.method === "POST") {
      if (!isAllowedOrigin(request)) {
        return jsonResponse({ error: "forbidden", message: "origin not allowed" }, 403);
      }
      return handleGenerate(request, env);
    }

    if (path === "/api/generate/stream" && request.method === "GET") {
      return handleStream(request, env);
    }

    if (path === "/api/quota" && request.method === "GET") {
      return handleQuota(request, env);
    }

    const m = path.match(/^\/api\/task\/([A-Za-z0-9_-]+)$/);
    if (m && request.method === "GET") {
      return handleTaskStatus(request, env, m[1]);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
};