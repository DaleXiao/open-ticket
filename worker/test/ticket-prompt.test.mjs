// Key-risk guards (decision-logic snapshots):
// the film title / showtime / seat strings must be injected verbatim into the image
// prompt, the CJK text-accuracy constraints must not be accidentally removed, and the
// layout constraints must stay in place: recognizable poster art, non-overlapping text,
// aligned date/time, random seat + bottom barcode, three main text lines +
// ELSEWHERE CINEMA kept, four text lines in total.
// Asserted via source snapshots because the worker source depends on Cloudflare
// globals and cannot be imported directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

test("film title and showtime injected verbatim into the image prompt", () => {
  assert.ok(src.includes('the film title, typeset large and elegant in an editorial Didone/Garamond serif, on its own line: "${title}"'));
  assert.ok(src.includes('the showtime, typeset smaller beneath the title in the same serif'));
  assert.ok(src.includes('"${showtime}"'));
});

test("random seat number injected into the prompt (line 4)", () => {
  assert.ok(src.includes('Line 4 — the seat number'));
  assert.ok(src.includes('"${seat}"'));
  assert.ok(src.includes('EXACTLY FOUR lines'));
  // The old "EXACTLY THREE lines" constraint must be gone (otherwise the three-to-four-line change never landed)
  assert.ok(!src.includes("EXACTLY THREE lines"));
  // The seat is generated randomly by the worker; no fixed copy allowed
  assert.ok(src.includes("generateSeat"));
});

test("bottom random-barcode constraint", () => {
  assert.ok(src.includes("barcode"));
  assert.ok(src.includes("decodes to no readable characters"));
  assert.ok(src.includes("random-width"));
});

test("three main text lines kept (ELSEWHERE CINEMA in uppercase small-caps)", () => {
  assert.ok(src.includes('"ELSEWHERE CINEMA"'));
  assert.ok(src.includes("small and letter-spaced uppercase small-caps, the fixed cinema name"));
  assert.ok(src.includes("EXACTLY FOUR lines"));
  // The old "EXACTLY TWO lines" constraint must be gone
  assert.ok(!src.includes("EXACTLY TWO lines"));
});

test("clean, non-overlapping text area constraint (prompt layer)", () => {
  assert.ok(src.includes("clean, unobstructed"));
  assert.ok(src.includes("never overlapping"));
});

test("date/time alignment constraint (prompt layer)", () => {
  assert.ok(src.includes("sharing the title's left (or center) alignment axis"));
  assert.ok(src.includes("share one alignment axis"));
});

test("recognizable-poster constraint (silhouette fidelity)", () => {
  assert.ok(src.includes("ICONIC BUT RECOGNIZABLE"));
  assert.ok(src.includes("silhouette"));
  assert.ok(src.includes("instantly recognizable"));
  assert.ok(src.includes("Flat solid fills, no gradients"));
});

test("serif typography written into the prompt (editorial serif / Didone/Garamond)", () => {
  assert.ok(src.includes("Didone/Garamond serif"));
  assert.ok(src.includes("elegant editorial hierarchy"));
});

test("CJK garbling-risk mitigations in place (construction guard)", () => {
  assert.ok(src.includes("complete, correct strokes"));
  assert.ok(src.includes("never simplified, broken, mirrored"));
  assert.ok(src.includes("character-for-character"));
});

test("prompt-rewrite model forbidden from writing the body text itself", () => {
  assert.ok(src.includes("NEVER WRITE TEXT"));
  assert.ok(src.includes("You must NOT reproduce or transliterate them"));
});

test("page-label words forbidden (no ADMIT ONE / no SEAT / no Film title)", () => {
  assert.ok(src.includes("no 'ADMIT ONE'"));
  assert.ok(src.includes("no 'SEAT'"));
  // The seat is now a legitimate line 4; the old "no seat numbers" constraint must be gone
  assert.ok(!src.includes("no seat numbers"));
});

test("no-emoji constraint written into the prompt (no emoji/pictographs anywhere on the ticket face)", () => {
  assert.ok(src.includes("No emoji, no pictographic or emoticon symbols anywhere on the ticket"));
});

test("image generation disables prompt expansion and watermark (text accuracy first)", () => {
  assert.ok(src.includes("prompt_extend: false"));
  assert.ok(src.includes("watermark: false"));
});

test("web search enabled: prompt-rewrite request carries enable_search", () => {
  assert.ok(src.includes("enable_search: true"));
  assert.ok(src.includes("enable_search?: boolean"));
});

test("web-search results preferred over training memory (system-prompt layer)", () => {
  assert.ok(src.includes("If web-search results are available for this film"));
  assert.ok(src.includes("prefer the freshest public material"));
});

// --- v1.6: premiere year + iconic quote (fine-print footnote above the barcode) ---

test("v1.6: year + quote extracted as fact fields via search (system-prompt layer)", () => {
  assert.ok(src.includes("FACT FIELDS"));
  assert.ok(src.includes("PREMIERE YEAR as a 4-digit year string"));
  assert.ok(src.includes("at most 10 Chinese characters"));
  assert.ok(src.includes("never paraphrase, never invent"));
  assert.ok(src.includes('"year": "4-digit premiere year, or empty string"'));
  assert.ok(src.includes('"quote": "one iconic short line from the film in its original language, or empty string"'));
});

test("v1.6: fine-print line injected into the image prompt (line 5, small italics above the barcode)", () => {
  assert.ok(src.includes("Line 5 — the fine-print line"));
  assert.ok(src.includes("NOTICEABLY SMALLER"));
  assert.ok(src.includes("gentle italic"));
  assert.ok(src.includes("directly above the barcode"));
  assert.ok(src.includes("EXACTLY FIVE lines"));
  assert.ok(src.includes('\u9996\u6620 ${year} \u00b7 ${quote}'));
});

test("v1.6: fact-field sanitization guards (better empty than wrong)", () => {
  assert.ok(src.includes("sanitizeYear"));
  assert.ok(src.includes("sanitizeQuote"));
  assert.ok(src.includes("QUOTE_MAX_CJK = 10"));
  assert.ok(src.includes("n >= 1888 && n <= 2035"));
});

test("v1.6: user overrides win over search results", () => {
  assert.ok(src.includes("overrides?.year"));
  assert.ok(src.includes("overrides?.quote"));
  assert.ok(src.includes("year: yearOverride, quote: quoteOverride"));
});

console.log("ticket-prompt snapshot tests passed");