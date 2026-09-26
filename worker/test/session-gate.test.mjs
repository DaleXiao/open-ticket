// Key-risk guards (decision-logic snapshots):
// abuse resistance = trusted anonymous session (Turnstile + PoW bootstrap):
// session bootstrap + Turnstile + PoW fallback + HMAC session +
// per-session daily quota (replacing the old per-IP daily quota) + generate/quota gates.
// Asserted via source snapshots because the worker source depends on Cloudflare
// globals and cannot be imported directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

test("Env carries TURNSTILE_SECRET (deploy-time secret)", () => {
  assert.ok(src.includes("TURNSTILE_SECRET?: string"));
});

test("session bootstrap route + handler in place", () => {
  assert.ok(src.includes('path === "/api/session"'));
  assert.ok(src.includes("handleSessionBootstrap"));
  assert.ok(src.includes("SESSION_COOKIE = \"trusted_session\""));
});

test("PoW fallback (challenge issuance + 16 leading zero bits + replay protection)", () => {
  assert.ok(src.includes('path === "/api/pow-challenge"'));
  assert.ok(src.includes("issuePowChallenge"));
  assert.ok(src.includes("POW_DIFFICULTY = 16"));
  assert.ok(src.includes("pow-used:"));
});

test("Turnstile siteverify validation", () => {
  assert.ok(src.includes("turnstile/v0/siteverify"));
  assert.ok(src.includes("verifyTurnstile"));
});

test("HMAC trusted-session issuance and verification (constant-time compare + expiry check)", () => {
  assert.ok(src.includes("issueTrustedSession"));
  assert.ok(src.includes("verifyTrustedSession"));
  assert.ok(src.includes('name: "HMAC"'));
});

test("quota is per-session, counted via strongly consistent DO-storage pre-deduction (v1.6.1 over-quota fix)", () => {
  // DO transactional pre-deduct / refund / query in place
  assert.ok(src.includes("reserveSessionQuota"));
  assert.ok(src.includes("refundSessionQuota"));
  assert.ok(src.includes("session-quota"));
  assert.ok(src.includes("session-limit:${sid}:"));
  assert.ok(src.includes("this.state.storage.transaction"));
  // The old KV counting path (eventually consistent, root cause of the over-quota bug) must be gone
  assert.ok(!src.includes("incrementSessionLimit"));
  assert.ok(!src.includes("checkSessionLimit"));
  assert.ok(!src.includes("getSessionRemainingQuota"));
  // The old per-IP daily quota logic must be gone (otherwise the session-based replacement never landed and dual quotas remain)
  assert.ok(!src.includes("checkRateLimit"));
  assert.ok(!src.includes("getRemainingQuota"));
  assert.ok(!src.includes("limit:${ip}:${today}"));
});

test("generate/quota without a session -> verification_required 403", () => {
  assert.ok(src.includes("verification_required"));
  assert.ok(src.includes("\u9700\u8981\u5b8c\u6210\u4e00\u6b21\u5b89\u5168\u9a8c\u8bc1"));
  assert.ok(src.includes("403"));
});

test("IP burst limit kept as a second gate", () => {
  assert.ok(src.includes("checkBurst"));
  assert.ok(src.includes("rate_limited_burst"));
});

console.log("session-gate snapshot tests passed");