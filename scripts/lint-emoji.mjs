#!/usr/bin/env node
// lint-emoji.mjs — no Unicode emoji in user-visible UI/copy.
//
// Scans frontend sources (src/ + index.html) and worker user-visible copy
// (worker/src); fails (exit 1) on any Unicode emoji / pictograph / VS16 / ZWJ
// match to prevent regressions.
//
// Usage: npm run check:emoji
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const SCAN_PATHS = ["src", "worker/src", "index.html"];
const FILE_EXTS = new Set([".html", ".ts", ".tsx", ".css", ".js", ".mjs", ".json"]);

// The Unicode property \p{Extended_Pictographic} covers the full emoji +
// pictograph spectrum; plus VS16 (emoji presentation selector) and ZWJ
// (emoji sequence joiner), the two paired forms.
const EMOJI = /\p{Extended_Pictographic}|\uFE0F|\u200D/gu;

function* iterFiles(path) {
  const full = join(root, path);
  const st = statSync(full);
  if (st.isDirectory()) {
    for (const name of readdirSync(full)) {
      yield* iterFiles(join(path, name));
    }
  } else if (FILE_EXTS.has(extname(full))) {
    yield full;
  }
}

const hits = [];
for (const p of SCAN_PATHS) {
  if (!statSync(join(root, p), { throwIfNoEntry: false })) continue;
  for (const f of iterFiles(p)) {
    const text = readFileSync(f, "utf8");
    // Report line by line for easy review. Emoji never appear in SVG path/viewBox
    // data, and frontend sources here are only JSX/TS/CSS/HTML, so no SVG
    // line-skipping rule is needed.
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      EMOJI.lastIndex = 0;
      if (EMOJI.test(line)) {
        const cps = [...line.matchAll(EMOJI)].map((m) => `U+${m[0].codePointAt(0).toString(16).toUpperCase()}`).join(" ");
        hits.push(`${relative(root, f)}:${i + 1}  [${cps}]  ${line.trim().slice(0, 100)}`);
      }
    });
  }
}

if (hits.length > 0) {
  console.error(`check:emoji FAILED — ${hits.length} match(es)\n`);
  for (const h of hits) console.error(`  ${h}`);
  console.error("\nUI and copy must stay plain text or inline SVG; no Unicode emoji.");
  process.exit(1);
}

console.log("check:emoji OK — zero Unicode emoji in src/, worker/src/, index.html.");