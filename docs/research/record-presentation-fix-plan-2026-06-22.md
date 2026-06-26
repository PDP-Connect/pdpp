# Record-presentation fix plan — the SLVP-ideal for undeclared row content (2026-06-22)

Fixes the live rewalk finding: rows show `Id: <uuid>` / `Cc: []` because records have no declared roles and the generic fallback presents `fields[0]` (arbitrary key order) as a confident primary. Grounded in `docs/research/record-presentation-ideal-2026-06-22.md` (3 angles, 98 sources) + the standing trust principle: **"stream display.detail is manifest-authored, never client-authored."**

Gate model: this plan → Codex sign-off (>95%) → build → Codex end-review → deploy → live rewalk. Base: deployed `9affb49a`. Authored by the owner. No origin push.

## The decisive research verdict (resolves a tension in my own instinct)
Trustworthy products AUTHOR the display field (Notion *requires* a title property, API-enforced; Airtable/Directus/Strapi/Salesforce author it). Products that DON'T (Supabase/Retool/Strapi-relations) end up showing raw IDs — exactly our bug. Metabase is the lone auto-detector and its own tracker documents the heuristic misfiring (#49783).

**CRITICAL correction to my first instinct:** the fix is NOT "rank generic fields by readability to pick a better pseudo-title." Research Angle 2 is explicit: auto-picking a title from data (longest text, name-like, etc.) is **client-authored display the trust model forbids** — it imports Metabase's failure mode (wrong field, *looks* authoritative, isn't). The principle is "everything shown is traceable to the manifest," not "always show something pretty."

## The SLVP-ideal = a tiered authorship model (research consensus)
- **Tier 0 — `primary-title` buys 80%.** One declaration per record-type → a correct title (Strapi mainField / Salesforce nameField / Backstage metadata.title). The documented "do at least this" for every connector.
- **Tier 1 — the closed role vocabulary we ALREADY have** (`secondary`/`actor`/`amount`/`event-time`). Messages declare `actor`+`secondary(body)`; transactions `amount`+`secondary(merchant)` — zero new components.
- **Tier 2 — declare-nothing degrades to HONEST GENERIC**: identity + key/value, NOT an invented title, NO field-name guessing (matches our already-shipped honest-generic decision + Plaid null-merchant precedent).

## What to actually build (two parts, both honest)

### Part 1 — Make the UNDECLARED generic row honestly generic (not a fake title)
The bug isn't just field ordering — it's that the generic row renders `fields[0]` with title styling (weight 600), making "Id: f5eee2d2…" LOOK like an authored title. Fix:
- A record with NO declared `primary-title` must NOT render a confident primary line. Present it as an explicit **generic/undeclared** row: the kind/stream label + an honest key/value pair, visually distinct from an authored title (the existing `derived`/quieter treatment exists — make undeclared rows clearly read as "undeclared", e.g. muted, not weight-600 title).
- Do NOT pick a pseudo-title by data-shape ranking (the Metabase trap). The honest move when nothing is declared is to show the record is undeclared, not to manufacture a title. (We MAY still de-prioritize pure-noise fields like empty arrays/`Cc: []` from the key/value SO THE GENERIC CARD ISN'T NOISE — but that's ordering the honest key/value table for readability, NOT promoting one to a title.)
- This keeps RL1 intact and removes the dishonesty (a UUID dressed as a title).

### Part 2 — Author `x_pdpp_role` in the manifests the owner actually has (the REAL fix, Tier 0/1)
The reason 100% of live rows are generic: the connectors the owner uses haven't declared roles. Author them (manifest-only, the trusted path — no client code):
- **chatgpt/messages, claude-code/messages, codex/messages**: `primary-title` = the message text/content (or a snippet field), `actor` = role/author, `event-time` = timestamp.
- **gmail/messages**: `primary-title` = subject, `actor` = from, `secondary` = snippet.
- **transactions (chase/usaa/ynab)**: `amount` = amount, `secondary` = merchant/payee, `event-time` = date.
- **github/repositories** already piloted (name→primary-title) — confirm pattern, extend to issues/PRs (title→primary-title).
- Scope to the owner's actual live connectors first (the ones showing in the feed); a manifest role declaration is additive + manifest-authored = the trusted mechanism. NO per-record-type bespoke UI code (Tier 1 closed vocabulary handles formatting).
- STOP-CONDITION: if a connector's records genuinely have no human-meaningful field to title (pure telemetry/inventory streams), leave them honest-generic — do NOT force a title. That's correct, not a gap.

## Feasibility CONFIRMED (checked live manifests + plumbing)
The real connector manifests are in `packages/polyfill-connectors/manifests/` (chatgpt.json, gmail.json, codex.json, claude_code.json — NOT reference-implementation/manifests/, which only has github+reddit). `buildFieldCapabilities` (server/index.js:2100) reads `schema.properties[field].x_pdpp_role` from them — the SAME plumbing as the github pilot. None of the owner's live connectors declare roles yet (`has_x_pdpp_role=False`), and they HAVE the fields to declare:
- chatgpt/messages: `content`→primary-title, `role`→actor, `create_time`→event-time (id is first → why the row showed "Id:")
- gmail/messages: `subject`→primary-title, `from_name`→actor, `date`→event-time (id/cc first → "Id:"/"Cc: []")
- codex/messages + claude_code/messages: `content`→primary-title, `role`→actor, `timestamp`→event-time
- chatgpt/conversations: `title`→primary-title
So Part 2 = manifest-only edits in packages/polyfill-connectors/manifests/, the trusted authorship path, github-pilot pattern, no client code. NOTE: deploy must rebuild so the bundled manifests update (the .next/standalone copies are build artifacts).

## Scope guard / honesty (non-negotiable)
- NO field-name guessing, NO data-shape title auto-pick (the Metabase trap). Declared-only.
- Keep dcfeb028 + 9affb49a guards: burst order, count==reachability, conditional inspector, the W1-W4 feel work, RecordroomShell, server contracts.
- Manifest role authoring is additive + manifest-authored (the trusted surface). The `x_pdpp_role` → field_capabilities[].role plumbing already exists (github pilot) — reuse it.

## Codex plan sign-off (tmp/workstreams/codex-record-presentation-plancheck.md): LAND @ 96% — HARD CONDITIONS folded in
- Part 1 must introduce ZERO replacement title heuristic: no longest-text, first-string, name/subject fallback, field-name scoring, stream-name noun, kind noun, or timeline summary may become the row primary for undeclared records.
- Undeclared generic rows: readable (de-noised key/value OK) but visually HONEST — no value rendered as a weight-600 authored title; the primary affordance reads neutral/generated/generic.
- Telemetry/system streams with no human-facing field STAY honest-generic. Do NOT force roles into coverage_diagnostics, config_inventory, cache_inventory, logs, etc. just to prettify.
- Manifest edits assign roles ONLY to fields that actually exist in the target stream schema (verify each stream before adding).
- `primary-title` = the vocabulary's "primary DISPLAY LINE" role, not a literal claim a message body is a title — acceptable for content/subject, but end-review verifies long tool-output rows truncate + keep secondary metadata usable.
- Keep all dcfeb028 + 9affb49a guards: no partial-role guessing leak, no entry.summary primary fallback, no field-order title promotion, no count/reachability regression, no row stream-drill reintroduction. entry.summary may stay search/filter INPUT, never display primary.

### Codex test pins (required):
1. Generic undeclared-row regression: fields begin with low-signal keys (id, cc, arrays, UUIDs, empty) → assert NONE rendered as a confident row title.
2. Manifest-role regression for ≥1 target stream: x_pdpp_role flows through field_capabilities[].role → buildRecordPreview → rowPrimary.
3. Stop-condition test: a no-human-field telemetry stream stays honest-generic after the manifest pass.
4. Live-failure-shape fixture: rows that showed "Id: <uuid>" / "Cc: []" no longer display those as primary titles.

## Tests / gates
- Generic undeclared row renders as honest-generic (no weight-600 fake title from `fields[0]`); a record with declared `primary-title` renders the title.
- Empty/noise fields (`Cc: []`, empty arrays) are de-prioritized in the generic key/value (readability) but NOT promoted to title.
- Each newly-authored manifest: a fixture record renders its declared `primary-title`/roles (extend rs-streams-field-declared-role.test pattern).
- tsc clean, console explore + operator-ui + reference tests green, openspec --strict if the x_pdpp_role spec changes, lint clean.

## Acceptance (live rewalk)
- Live feed: rows for the owner's chatgpt/gmail/transaction/etc. connectors show REAL content (message snippet, subject, merchant+amount) — not `Id:`/`Cc:`.
- Any still-undeclared connector reads as an honest generic record (clearly undeclared), NOT a fake-titled UUID row.
- Both Codex and Claude >95% confident this is the SLVP-ideal.
