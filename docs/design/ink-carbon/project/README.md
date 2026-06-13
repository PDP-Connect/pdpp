# PDPP Design System — Ink Carbon

**PDPP** — Personal Data Portability Protocol — is an open specification for how personal user data flows through the digital economy under **authorization-first, purpose-bound** access. Clients request named records and fields. Every response stays inside the grant.

**Ink Carbon** is the system's visual language. It renders the protocol's core promise — *the protocol always leaves you your copy* — literally:

1. **The carbon duplicate.** Objects the server retains on the owner's behalf (a staged consent request, a held grant, an export in flight) cast an offset copy behind themselves (`.pdpp-carbon`). Depth is never decoration; if you see a second sheet, a second copy exists and it is yours.
2. **The typed voice.** Everything the protocol writes — IDs, scopes, terms, timestamps, endorsements — is set in mono. Everything addressed to a human is grotesk. Authorship is carried by the *voice*, not by a colored stripe.
3. **Spent color.** Hue marks authorship and state, never decoration. Protocol ink on protocol-authored emphasis; human warmth only where the owner acts; state colors only inside endorsements.
4. **Paper geometry.** Sheets, rows, and bands are square. Controls get a 2px ease (`--radius-control`) — the only rounding in the system.

This system targets the surfaces shipped by `vana-com/pdpp`: the operator console (`apps/console`, dark), the hosted consent / device / owner pages (`reference-implementation/server/hosted-ui.js`, light), and the public site & docs.

---

## CONTENT FUNDAMENTALS

PDPP copy is **quiet, technical, and direct**. It treats the reader as a builder who will read the spec, not a consumer to be wooed. There is zero hype.

**Tone:** calm, spec-adjacent, factual. "The grant is the portable consent artifact." "Only the granted fields come back." Sentences are short; verbs lead; modifiers are cut. Copy often pairs a plain-English claim with the protocol's own typed term right next to it (e.g. "Access mode — `continuous`").

**Voice:** PDPP speaks *about* the protocol, not *as* the protocol. Third-person. "The resource server enforces the boundary." Never "we enforce the boundary." First-person only appears in quoted client commitments — and the UI explicitly labels those as client claims, not platform truth.

**You / I:** Second-person ("your server", "your data") is used in *user-facing* consent flows where the reader *is* the owner. Everywhere else, third-person ("the client", "the grant", "the server"). Never "I" from the platform.

**Casing:** Sentence case for all headings and buttons. Uppercase **only** in the mono voice: eyebrows and the carbon copyline. Code identifiers stay lowercase (`pay_statements`, `single_use`, `purpose_code`).

**Emoji:** None. Glyphs from the typeface instead (see Iconography).

**Vibe:** a well-edited RFC with a visual designer on staff. Every sentence earns its place.

**Examples (verbatim):**

> "Granular access to personal data. Clients request named records and fields. Every response stays inside the grant."

> "One-time access. Your server will not allow further queries."

> "Carbon — your copy stays here."

> "These are their commitments, not enforced by your server."

---

## VISUAL FOUNDATIONS

### The duality, restated
Human vs protocol survives from the previous system, but the rendering changed. The author of a surface shows in its **voice** (grotesk vs mono) and, where needed, a **flat tint** (`[data-surface="human"|"protocol"]` — 1px hairline + 5% color-mix fill). There is **no colored left border, no gradient wash, no resting shadow** anywhere in the system. Never mix two temperatures on one card.

### Colors
- **Paper** — `--background: oklch(0.985 0.004 90)`. Warm-cast near-white.
- **Ink** — `--foreground: oklch(0.18 0.005 270)`.
- **Protocol ink** — `--primary: oklch(0.46 0.11 255)`. Deeper and drier than the old `#187adc` — ink, not LED. Eyebrows, links, the carbon, protocol emphasis.
- **Human** — `--human: oklch(0.55 0.11 45)`. Spent only where the owner acts: the approve button, the owner badge.
- **Carbon** — `--carbon-fill` (primary @ 9%), `--carbon-outline` (primary @ 40%), `--carbon-offset: 9px`.
- **State** — `--success` (recorded/active, H158), `--warning` (expiring, H70), `--destructive` (destructive acts only, H27). Each appears **only inside endorsements** and the matching action.
- **Dark** — full token set under `html.dark` / `html[data-theme="dark"]`: charcoal with a cool cast (`oklch(0.17 0.006 262)`), lifted accents. The console runs dark; hosted pages run light.

### Typography
- **Sans** — Schibsted Grotesk (400–900). The human voice. Display runs heavy (700–800) with tight tracking.
- **Mono** — JetBrains Mono. The protocol's voice. Always `tabular-nums` for data.
- **Scale** — `.pdpp-display-lg` (60/700), `.pdpp-display` (40/700), `.pdpp-heading` (20/700), `.pdpp-title` (14/600), `.pdpp-body-lg` (18), `.pdpp-body` (14), `.pdpp-label` (12/500), `.pdpp-caption` (12), `.pdpp-typed` (mono 13/500), `.pdpp-typed-sm` (mono 11), `.pdpp-eyebrow` (mono 10.7/0.12em/uppercase, protocol ink).
- **The voice rule:** if the protocol wrote it, it is mono. If a human wrote it or is being addressed, it is grotesk. No exceptions — this is the system's strongest signal.

### The carbon (elevation)
- Resting surfaces are **flat**: `var(--card)` behind a hairline. No drop shadows. Floating layers (menus, dialogs) are the single shadow exception.
- `.pdpp-carbon` casts the duplicate: offset `9px/9px`, `--carbon-fill` + 1px `--carbon-outline`. Held rows in data lists use the inline variant (`.pdpp-data-row--held`).
- **Budget:** carbon appears only when the server retains a copy on the owner's behalf. A screen with nothing retained shows no carbon. If carbon appears on more than ~2 objects per screen, something is wrong.

### Revocation
Revoked objects are **struck, not erased** — `line-through` on title and detail, muted ink. The record survives revocation; the strike is the proof. Never delete a row to show revocation.

### Geometry
- Radius: `0` on sheets, rows, bands, tints. `--radius-control: 2px` on buttons and inputs. Nothing is a pill.
- Rules: `1px solid var(--border)` between rows; `--border-strong` on sheet edges and list tops. No double rules, no colored dividers.
- Spacing: 4px grid. Sheet padding `13–18px`; row padding `10–11px` vertical.

### Animation
Tokens unchanged: `--duration-*`, `--ease-*`, `--motion-*`, `--stagger-*`. No bounces, no parallax. Reduced motion collapses durations to 0.01ms. The carbon does not animate in resting UI; it may slide in (`--motion-enter`) when an object becomes retained.

### Components (ui_kits/web/kit.css)
- `.pdpp-sheet` (+ `__head/__title/__serial/__body/__foot`) — the paper artifact.
- `.pdpp-carbon` — the duplicate wrapper. `.pdpp-copyline` — its caption ("Carbon — your copy stays here").
- `.pdpp-scope` (+ `--off`) — consent scope rows; declined scopes are struck, not hidden.
- `.pdpp-table` (+ `__hrow/__h`, `--cols` on the wrapper) — the aligned list. One column template per table, set once on the wrapper, so every cell in a column shares an axis. **Headers are mandatory** — a column the user must infer is a column mislabeled. Numeric columns right-align (`u-r`) with `tabular-nums`.
- `.pdpp-data-row` (+ `--revoked`) — rows inside a table.
- `.pdpp-endorse` (+ `--active/--continuous/--expiring/--revoked/--denied`) — typed status. The only home of state color.
- `.pdpp-tag` — neutral typed taxonomy.
- `.pdpp-btn` (+ `--human/--ghost/--destructive/--sm`) — ink-filled default; the human variant is reserved for the owner's act of consent.
- `.pdpp-input`, `.pdpp-field` — mono values, grotesk labels.
- `.pdpp-kv` — typed record block. `.pdpp-band` — dataset summary strip.

---

## ICONOGRAPHY

**PDPP does not use an icon set.** Meaning is carried by words, structure, and glyphs from the typeface: `●` active, `○` pending, `◐` expiring, `⊘` revoked, `→` flow, `›` disclosure, `↺` reset, `✓` approved, `×` declined. Client monograms are two-letter uppercase mono on a bordered square. **Never:** emoji, Lucide/Material/FontAwesome, decorative SVG, pictographic line icons. If a label needs a picture, fix the label.

---

## Fonts

Google Fonts CDN: Schibsted Grotesk + JetBrains Mono (imported at the top of `colors_and_type.css`). For offline bundles, self-host the WOFF2s under `fonts/` and replace the import.

---

## Index

Root files:
- `README.md` — this file
- `SKILL.md` — agent entry point
- `styles.css` — single entry point (imports everything below)
- `colors_and_type.css` — tokens (light + dark), type classes, carbon, surfaces

Folders:
- `preview/` — the Design System tab cards
- `ui_kits/web/` — component kit (`kit.css`) + reference site components *(JSX components pending Ink Carbon restyle)*
- `explorer/`, `labs/` — app-layer surfaces *(pending Ink Carbon restyle)*
- `reinvention/` — the exploration history that led here (Rounds 1–3)
- `reference/` — upstream source snapshots from `vana-com/pdpp` (`.txt`, not compiled)

## Caveats for iteration

1. **Explorer, labs, and the web-kit JSX components still wear the previous system.** Tokens are aliased (`--*-wash` → `--*-tint`) so nothing breaks, but they need a deliberate restyle pass.
2. **Dark mode ships real values now** — the console is dark-first; hosted pages stay light.
3. **No photographs, no illustrations.** Everything is typographic and token-driven. The mark is a square ink monogram (see Brand card).
