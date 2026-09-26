# Design language

open-ticket is styled as a **vintage cinema ticket stub** — letterpress ink on warm paper stock, not a SaaS dashboard and not "AI neon". The bar: nobody should glance at it and think "generic AI output".

## Brand personality

Three words: **nostalgic, warm, crisp.**

Think of the ticket slot of a 1970s cinema box-office machine — keys that click, paper with visible fibre, ink pressed into the sheet rather than floating on glass.

## Aesthetic direction

Editorial vintage ticket stub (letterpress + editorial-typesetting feel):

- Old cinema / theatre tickets — punch holes, perforated tear edges, monospaced fields, printed-matter texture.
- Letterpress — ink pressed into the paper.
- Editorial language: film-grain overlay, numbered sections, restrained motion, generous whitespace.

Explicit non-goals: SaaS card walls, cyan-on-black "AI look", purple-to-blue gradients, glassmorphism, neon glow, big-number hero metrics, pure black/white, rounded card grids, default system fonts, emoji icons, centered slogan clichés.

## Typography (serif-led)

- **Latin display / film title: Cormorant Garamond** — the Didone/Garamond-flavored editorial serif that carries the ticket-face character.
- **Chinese UI text: Noto Sans SC** — UI Chinese is always sans-serif; the serif ticket-face lettering exists only inside the generated image (controlled by the image prompt's Didone/Garamond instructions, never by browser fonts).
- **UI chrome / labels / buttons: Space Grotesk** — a characterful grotesque for functional text such as field labels.
- Ticket fields (date/time) echoed in HTML use the Latin serif with `tabular-nums` alignment.
- One modular scale ratio (1.25) site-wide; display sizes are fluid via `clamp()`.

## Color & themes

**Light (warm paper):**

- Background `oklch(0.965 0.014 82)` — warm cream stock (never pure white) + film-grain overlay.
- Ink `oklch(0.26 0.02 55)` near-black text (never `#000`).
- A single accent: **gold `#d4a054`** — only for the generate action, brand dots and focus states; never spread across surfaces.

**Dark (deep warm base, the default):**

- Background `#0c0b09` — deep warm near-black, not blue-black.
- Raised surface `#15120d`; ink flips to warm white `oklch(0.87 0.014 78)`.
- Accent unchanged: gold `#d4a054`, brightening to `#e2b877` on hover.
- Border `oklch(0.28 0.014 72)`; grain opacity slightly higher.

Modern CSS: `oklch`, `clamp`, hand-written theme variables. Themes switch via a `.dark` class + CSS custom properties, persisted in `localStorage`, with an inline script in `index.html` pre-applying the class before hydration (no first-paint flash).

## Layout & space

- Single centered column, generous whitespace. **The only "card" is the ticket itself** (it has earned the right to be one) — the input form is an underline-style editorial form with numbered sections, not a wall of cards.
- Varied section rhythm (header / form / result / footer each breathe differently) instead of uniform padding.
- Punch holes, the perforated tear edge and left-edge notches are **authentic ticket vocabulary**, not decoration.

## Motion & loading

- Restrained: one choreographed loading sequence (skeleton shimmer + spinner + result fade-in) beats scattered micro-interactions.
- The spinner is a **sunburst** — a rotating circle with radiating rays (`animate-spin`, 1s linear) — consistent with the no-emoji rule.
- transform/opacity only, exponential ease-out, and `prefers-reduced-motion` respected.
- A trailing light spot follows the pointer: a projector beam (dark theme) or a pool of daylight (light theme), rAF-lerped; static and centered under reduced-motion or on touch devices.

## No-emoji principle

Zero Unicode emoji anywhere — UI, copy, and generated images. Icons are inline SVG, and the emoji lint (`npm run check:emoji`) fails the build on any emoji / pictograph / VS16 / ZWJ found in `src/`, `worker/src/` or `index.html`.

## Design principles

1. **Ticket vocabulary is the identity** — punch holes, tear edges, serif/mono fields, printed texture; first make it read as a real ticket.
2. **Restraint before decoration** — every element needs a ticket-face reason to exist; when in doubt, cut it.
3. **Warm paper + ink + a touch of gold** — never AI neon, gradients or glass.
4. **Serif-led ticket face + sans UI** — Cormorant Garamond carries the Latin ticket character, Noto Sans SC the Chinese UI, Space Grotesk the chrome; serif lettering inside generated images is controlled by the image prompt.
5. **Pass the AI-slop check** — if it reads like generic AI output, redo it.

## Scope notes

`src/index.css` is the single styling entry point — Tailwind is deliberately not used, trading ecosystem convenience for full control over the ticket vocabulary. The ticket image itself is written end-to-end by the image model (text baked into the picture); the frontend only renders the ticket frame, the input form, and the download/regenerate actions. i18n (`src/i18n.ts`) and theme toggling use a small hand-rolled external-store pattern.
