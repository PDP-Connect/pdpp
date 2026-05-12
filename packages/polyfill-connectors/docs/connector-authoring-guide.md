# Connector authoring guide

This document captures the standards, heuristics, and earned lessons for writing polyfill connectors in this package. It is prescriptive: if you're writing a new connector or auditing an existing one, treat this as the floor, not the ceiling.

The guide is written for connector *authors*. It does not describe the Collection Profile wire protocol (that's in `spec-collection-profile.md`) or the Polyfill Runtime (that's in `spec-polyfill-runtime.md`). It describes how to write the code between those two layers.

## The entry point: `runConnector()`

Every connector is one call to `runConnector()`. The runtime owns the Collection Profile protocol handshake (START / RECORD / STATE / SKIP_RESULT / PROGRESS / DONE), browser lifecycle, tracing, fixture capture, retryable-error detection, and terminal exit. Connectors own business logic — how records are collected, shaped, and cursored.

```js
import { runConnector } from '../../src/connector-runtime.js';
import { validateRecord } from './schemas.js';

runConnector({
  name: 'notion',
  validateRecord,            // optional; Zod-ish { ok, data | issues } shape
  retryablePattern: /ECONN|fetch failed|rate_limited/i,
  async collect({ scope, state, requested, emit, emitRecord, progress, sendInteraction, emittedAt }) {
    // business logic only
  },
});
```

For browser-driven connectors, add `browser: { profileName, headless }`:

```js
runConnector({
  name: 'amazon',
  validateRecord,
  browser: { profileName: 'amazon' },
  async ensureSession({ context, page, sendInteraction }) { ... },
  async collect({ page, scope, state, emitRecord, capture, ... }) { ... },
});
```

What the runtime provides to `collect()`:

| param | what it is |
|---|---|
| `scope` | the full `START.scope` object |
| `state` | stream-keyed state map from `START.state` |
| `requested` | `Map<streamName, streamScope>` built from `scope.streams` |
| `emit` | `(msg) => Promise<void>` — raw emit, for STATE/PROGRESS/SKIP_RESULT |
| `emitRecord` | `(stream, data) => Promise<void>` — handles id-skip, resources filter, `scope.time_range` filter, Zod shape-check, counters |
| `progress` | `(message, extra?) => Promise<void>` — convenience for PROGRESS |
| `sendInteraction` | `({ kind, message, schema?, timeout_seconds? }) => Promise<response>` — the runtime fills `type` + `request_id` |
| `capture` | `null` unless `PDPP_CAPTURE_FIXTURES=1`; exposes `captureDom(page, label)` + `captureHttp(label, body, meta)` |
| `emittedAt` | one ISO timestamp for the run; use it on all records |
| `page`, `context` | only when `browser` is set |

**Do not write protocol plumbing.** No `process.stdin` readline, no stringify/emit wrapping, no `flushAndExit`, no `main().catch`. The runtime owns all of it. If you find yourself needing to bypass the runtime for a protocol concern, that's a signal to extend the runtime — not work around it.

## Standard dependencies (as of 2026-04)

Use these libraries by default. They are chosen because they are actively maintained and are the community defaults in 2026:

- **`patchright`** — Playwright drop-in with stealth patches (Runtime.Enable, Console.Enable, command-flag leaks, and others). Replaces `rebrowser-playwright` which went stale in mid-2025. Per the patchright README "Best Practice" config, `launchPersistentContext` is called with `channel: "chrome"`, `viewport: null`, and `headless: false`; do **not** set custom `userAgent` or extra browser headers; do **not** re-add the Chromium flags patchright manages (`--disable-blink-features=AutomationControlled` (added by patchright), `--enable-automation`/`--disable-popup-blocking`/`--disable-component-update`/`--disable-default-apps`/`--disable-extensions` (removed by patchright)). The reference auto-detects: if real Chrome (system or `pnpm --dir packages/polyfill-connectors exec patchright install chrome`) is available it uses `channel: "chrome"`; if not, it falls back once to bundled Patchright Chromium (installed by `pnpm install` postinstall) and logs the fallback. The reference Docker image installs real Chrome explicitly so the recommended channel is the default in-container. `PDPP_BROWSER_CHANNEL=<value>` is a strict override (no fallback). For best stealth on a host checkout, run `pnpm --dir packages/polyfill-connectors exec patchright install chrome` once. Override `args` only for specific workarounds (e.g. the DownloadBubble bug).
- **`zod`** — schema validation. Each connector exports schemas for its streams in `schemas.js`; the connector validates records before emit and sends `SKIP_RESULT` on validation failure. See §3.
- **`p-retry`** (v8+) — retry with exponential backoff + jitter for transient network/5xx/429 errors. Use `AbortError` to signal non-retryable failures.
- **Native Playwright tracing** (`context.tracing.start()` / `.stop()`) — gate behind `PDPP_TRACE=1` env, write to `/tmp/<connector>-trace-<ts>.zip`. Replayable in Playwright Inspector.

Do **not** use:
- `rebrowser-playwright` (stale since 2025-05)
- `puppeteer-extra` / `puppeteer-extra-plugin-stealth` (unmaintained since 2023)
- `async-retry`, the owner-kos `retry` (both dormant since 2021)
- Custom hand-rolled retry loops or validators when the above cover the case.

---

## 0. Browser architecture (for scrapers)

Browser-backed connectors declare `browser: { profileName, headless }`; the runtime then calls `acquireBrowserForConnector()` from `src/browser-launch.ts`. This routes through the host browser bridge when explicitly configured for Docker, otherwise it falls back to the native isolated launcher.

Native isolated launches use `acquireIsolatedBrowser({ profileName: '<connector>' })`. This:

- Launches patchright-patched Chrome per connector run (full stealth: launch-side AND client-side).
- Uses a persistent profile directory at `~/.pdpp/profiles/<connector>/`, so cookies, localStorage, and trusted-device state persist across runs of that connector.
- Is isolated from other connectors (different profile dir = different fingerprint, different cookies, no cross-contamination).
- Supports concurrent runs across connectors (each connector has its own browser process; no lockfile).

The runtime router is the only connector-facing browser-launch primitive. The legacy shared browser daemon and shared profile launcher were retired 2026-04-25 (`openspec/changes/retire-browser-daemon`).

Multi-account note: the runtime today defaults `profileName` to the connector name, which is single-account by design. When multi-account support ships, the convention will become `${connectorName}__${subjectId}` so two accounts on the same platform get independent profile directories.

**When to deviate**: if a connector is so cheap (a single HTTP call behind a session) that launching a full browser per run is wasteful, prefer a plain HTTP client (`fetch`, session cookies from a stored JSON). Scraping that drives a UI belongs in the isolated-browser pattern.

---

## 1. Sources of ground truth, ranked

When deciding where a connector gets its data, prefer in this order:

1. **Official API** — OAuth, API key, or equivalent. Stable, versioned, contract-respecting. Examples in this repo: `ynab` (PAT), `oura` (OAuth), `strava` (OAuth), `spotify` (OAuth API partial).
2. **Archive / compliance export** — GDPR/CCPA "download your data" flows. High-latency but stable, complete, regulator-backed. Examples: `google_takeout`, `twitter_archive`. See `openspec/changes/add-polyfill-connector-system/design-notes/platform-archive-requests-open-question.md` for the open design questions around this surface.
3. **Structured web endpoints** — JSON-over-the-wire that the site's own SPA consumes. Reverse-engineerable; shape usually stable.
4. **HTML scrape** — last resort. Locale-bound, A/B-test-bound, TOS-adjacent. Examples: `amazon`, `chase`, `usaa`.

Never mix modalities for a stream without a plan. If the same stream can be populated by API *and* scrape, you need an explicit decision about which wins on conflict (see §7 on record-key discipline).

---

## 2. For scrapers: structure over text

**The single most common way connectors break is regexing over concatenated `innerText`.** Text is locale-bound, A/B-test-bound, accessibility-bound. Structure is not.

### Prefer, in order:

1. **Stable structural attributes** — `id`, `data-component`, `data-testid`, `data-automation-id`, ARIA roles. These are English-in-code on sites that ship them, regardless of page language.
2. **Stable CSS classes** — `.od-item-view-qty`, `.a-fixed-left-grid-col`. Less durable than attributes but often stable for years.
3. **Semantic hierarchy** — walking up from a known anchor (e.g. an item's `<a href="/dp/...">`) to the nearest structural parent.
4. **Last**: visible text matching — only when the above are all absent.

### Avoid:

- `innerText` of a large container followed by regex. The string "Grand Total: $12.34" does not exist on a German page.
- Card-brand enumerations (`Visa|Mastercard|Amex|...`). Structural match on `<span>…</span>ending in <digits>` is locale-independent.
- Line-based parsing (`text.split('\n')[3]`). Whitespace semantics change across browsers, locales, and screen readers.

### Concrete example — good vs. bad

**Bad** (Amazon text-regex pattern we're moving away from):

```js
const summaryText = summaryBox.innerText;
const shipMatch = summaryText.match(/Ship to\s+(.+?)\s+Payment method/i);
const shipping_address = shipMatch ? shipMatch[1].trim() : null;
```

**Better** (structural DOM walk):

```js
const shipBlock = summaryBox.querySelector('[data-component="shipToAddressDisplay"]');
const shipping_address = shipBlock?.innerText.trim() || null;
```

**Best** (structural + field-specific children):

```js
const shipBlock = summaryBox.querySelector('[data-component="shipToAddressDisplay"]');
const recipient_name = shipBlock?.querySelector('.recipient')?.innerText.trim() || null;
const street = shipBlock?.querySelector('.line1')?.innerText.trim() || null;
```

Even when the display strings are French, the `data-component` and class names are not.

---

## 3. Fail loud, fail null, never fail wrong

The invariant: **a connector must never emit a record that looks right but is wrong.**

Corrupt data is worse than missing data. A null field is a clear signal; a string that looks like a recipient but is actually a parsing artifact silently poisons downstream use.

### Pattern: Zod schema per stream, validated before emit

Define schemas in a `schemas.js` adjacent to your connector entry. Export a `validateRecord(stream, data)` helper that returns `{ ok: true, data }` or `{ ok: false, issues }`. In `emitRecord`, call it and fork to SKIP_RESULT on failure. See `connectors/amazon/schemas.js` for the canonical example.

```js
// schemas.js
import { z } from 'zod';

export const orderSchema = z.object({
  id: z.string().min(5).max(40),
  recipient_name: z.string().min(2).max(80)
    .refine((s) => !/[$\t\n]|Buy it again/i.test(s), { message: 'cruft' })
    .nullable(),
  payment_method_summary: z.string()
    .refine((s) => !/Unable to display|\$\d/i.test(s), { message: 'non-answer' })
    .nullable(),
  order_total_cents: z.number().int().min(0).max(10_000_000).nullable(),
  // ...
});
```

```js
// index.js
import { validateRecord } from './schemas.js';

const result = validateRecord(stream, data);
if (!result.ok) {
  emit({ type: 'SKIP_RESULT', stream, reason: 'shape_check_failed',
         message: `${data.id}: ${result.issues.map(i => `${i.path}: ${i.message}`).join('; ')}`,
         diagnostics: { id: data.id, issues: result.issues, record: data } });
  return;
}
emit({ type: 'RECORD', stream, key: data.id, data, emitted_at: nowIso() });
```

### Why this matters more than it looks

You can't run a new connector against a new user's account ahead of time. Shape assertions replace that test. If the connector works on your account AND its shape assertions are tight, you have high confidence it will either work correctly on another account or fail visibly — not produce garbage.

---

## 4. Naming and schema discipline

- **Record keys must be stable across runs.** Use canonical IDs (ASIN, orderID, messageID, timestamp if that's the platform's own key). Never embed wall-clock time, random UUIDs generated at scrape-time, or derived hashes of volatile content.
- **Record keys must be unique within a stream.** If two records share the same key, the later one upserts the earlier. Make sure that's what you want.
- **Nullable fields return `null`, not sentinel strings.** Not `""`, not `"unknown"`, not `"Unable to display"` (looking at you, Amazon). If the platform says "we can't show this", your connector should say `null`.
- **Booleans return `true`/`false`/`null`.** Not `"yes"`, not `0`/`1`. `null` means "don't know," `false` means "confirmed no."
- **Currency amounts are ints in the smallest unit** (cents). Human-readable format goes in a parallel `*_display` field if the raw string is useful for debugging.
- **Timestamps are ISO-8601 strings.** Dates are `YYYY-MM-DD`. Never platform-specific formats.
- **Stream names are plural nouns.** `orders`, `messages`, `transactions`. Not `order_list`, not `orderHistory`.

---

## 4a. Text fields, the printable-text invariant, and `pdppSafeText`

PDPP's storage invariant: **every field declared by a connector schema as PDPP text MUST contain only PDPP-safe Unicode text.** Binary or control-rich payloads MUST NOT be stored directly in `record_json`; they MUST be stored in the `blobs` table, with `record_json` containing either `null` or an explicit typed reference.

This rule is enforced by two complementary layers:

- **At parse time** by `safeTextPreview()` — the helper a connector calls when it's *deciding* whether a captured value is safe text or needs to be routed to a blob.
- **At validation time** by the `pdppSafeText` Zod brand — the schema-level gate that catches mistakes where a parser inlined binary content anyway.

A correct connector uses both layers. A connector that forgets to call `safeTextPreview` and tries to assign bytes to a text field gets caught by `pdppSafeText`'s schema refinement with a precise error.

Any field destined for a JSONB **text column** — previews, snippets, message bodies, tool-result summaries, captured human-readable content — MUST pass through `safeTextPreview()` at parse time AND be typed `pdppSafeText` (or a derived brand) at the schema layer. No exceptions.

### Why

1. **Postgres JSONB rejects U+0000.** Postgres' JSONB type cannot store a string value containing a NUL byte; the server returns SQLSTATE `22P05` and the insert fails. SQLite is permissive and will happily store NULs, which means a connector that "works" in dev (SQLite) will hard-fail in production (Postgres) the first time a captured payload contains a stray NUL.
2. **Binary content belongs in `blobs`, not in JSONB.** The `blobs` table is content-addressed by sha256 and built for arbitrary bytes. If a field's value is binary, route the bytes to a blob and set the preview to `null`. Don't try to "make it fit" by stringifying binary data.
3. **Preview fields are human-readable summaries.** They have an upper bound (`PDPP_PREVIEW_MAX_CHARS = 4000`), a printable-text invariant (no C0 controls other than `\t`, `\n`, `\r`; no DEL; no C1 controls), and are meant to surface to people. They are not a place to dump captured bytes "just in case."

### The invariant

After `safeTextPreview()` returns `kind: "text"`, the resulting `preview` string is guaranteed:

- free of U+0000;
- free of other C0 control characters except `\t`, `\n`, `\r`;
- valid UTF-8 (if the input was a `Buffer`/`Uint8Array`);
- at most `maxChars` characters long, truncated with a `…` sentinel at a code-unit boundary that does not split a surrogate pair.

### Schema-level enforcement: `pdppSafeText`

Every text-bearing field in a connector schema (`schemas.ts`) MUST use the `pdppSafeText` brand instead of bare `z.string()`. Composition with `.max()`, `.min()`, `.nullable()`, `.optional()`, etc. works as expected:

```ts
import { z } from "zod";
import { pdppSafeText, nullablePdppSafeText } from "../../src/pdpp-safe-text.ts";

// Free-form human-readable text:
const titleSchema = pdppSafeText.max(500).nullable();
const bodyTextSchema = pdppSafeText.max(10_000_000).nullable();
const snippetSchema = nullablePdppSafeText; // when no max bound is meaningful

// Structurally-constrained strings (IDs, ISO dates, currencies) stay
// as z.string().regex(...) — regex shape is enough; the brand adds nothing.
const sessionIdSchema = z.string().regex(/^[0-9a-f-]{36}$/);
```

**Audit rule:** after rollout, a connector's `schemas.ts` should contain no semantically anonymous `z.string()`. Every text field declares its intent: `pdppSafeText` (human-readable text), `z.string().regex(...)` (structurally constrained), or `z.string().url()` (URL). A bare `z.string()` in a connector record schema is suspicious and should be reviewed.

The `pdppSafeText` brand produces a TypeScript nominal type `PdppSafeText`. Downstream code that accepts `PdppSafeText` is statically prevented from receiving an unvalidated `string`.

### The canonical parse-time pattern

```ts
import { safeTextPreview, PDPP_PREVIEW_MAX_CHARS } from "../../src/safe-text-preview.ts";

// Simple case: a string-typed preview field.
export function textPreview(s: unknown, max = PDPP_PREVIEW_MAX_CHARS): string | null {
  return safeTextPreview(s, max).preview;
}

// "Might be binary" case: pair the preview with a companion *_binary_reason
// field so consumers can tell "we didn't capture this" from "this was empty".
export function payloadOutputPreview(
  output: unknown,
  max = PDPP_PREVIEW_MAX_CHARS,
): { preview: string | null; binaryReason: string | null } {
  let toPreview: unknown = output;
  if (typeof output !== "string" && output !== null && output !== undefined) {
    toPreview = JSON.stringify(output);
  }
  const r = safeTextPreview(toPreview, max);
  return {
    preview: r.preview,
    binaryReason: r.kind === "binary" ? r.reason : null,
  };
}
```

See `connectors/codex/parsers.ts` and `connectors/claude_code/parsers.ts` for the established usage. Other previews should mirror those shapes.

### The `_binary_reason` companion-field convention

When a payload *might* be binary (raw bytes from a shell command's stdout, a tool result, a clipboard capture, an attachment), pair the preview field with a sibling `<field>_binary_reason` field:

| field | type | meaning |
|---|---|---|
| `output` | TEXT (JSONB-safe) | the preview from `safeTextPreview().preview`, or `null` |
| `output_binary_reason` | TEXT | when the helper returned `kind: "binary"`, the helper's `reason` string (e.g. `"U+0000 at offset 342"` or `"invalid UTF-8 sequence in buffer"`); `null` otherwise |

Rules:

- If `safeTextPreview()` returns `kind: "binary"`, set the preview field to `null` AND set `<field>_binary_reason` to `result.reason`.
- If it returns `kind: "text"` or `kind: "empty"`, set the preview field to `result.preview` (which is `null` when empty) AND set `<field>_binary_reason` to `null`.
- The actual bytes, if you care about preserving them, go to the `blobs` table — never inlined into the JSONB record.
- The reason string is for telemetry/debugging only; it is short, ASCII, and safe to render.

### Don't do this

- **Don't** stringify a `Buffer` directly into a preview field. The result will be valid UTF-8 by coincidence at best, and will contain forbidden control bytes at worst.
- **Don't** `String(value).replace(/\0/g, '')` as a workaround. That hides the binary-leak bug and silently lossy-coerces real data. Use `safeTextPreview()` and route binary to a blob.
- **Don't** invent a new "I'll just truncate to 200 chars" helper. Use `safeTextPreview(value, 200)` — the truncation logic already handles surrogate pairs and the printable-text invariant.

---

## 5. Session-state pattern

- **Probe before login.** A cheap auth check before driving credentials saves rate-limit budget and human patience.
- **Login before challenge.** Drive credentials from env/secrets. If a challenge (OTP, 2FA, SMS) fires, emit `INTERACTION kind=otp` and block until the orchestrator forwards the code.
- **Never assume a human is present.** A connector running unattended at 3am must either complete or emit a clear INTERACTION; it must not hang, retry indefinitely, or produce partial output.
- **Session elevation is a thing.** Some platforms (Amazon Privacy Central) require a *recent* password entry even for logged-in sessions. Handle these distinct from "session dead".
- **Cookie longevity varies.** Chromium drops `Session`-scoped cookies (no `Max-Age`) when the process exits. For platforms whose auth uses such cookies (USAA), accept that each run will re-auth via `ensureSession` — the connector's auto-login flow handles this. The runtime model serializes runs per connector and schedules them well outside any in-memory session-cookie window, so a long-lived daemon would not buy anything in practice.

---

## 6. Cursor and incremental discipline

### Incremental cursors

- Use the platform's native cursor when one exists (timestamps, opaque next-page tokens, highest message ID). Don't invent cursors where the platform has none.
- Persist cursor as part of the STATE message. Runtime handles durability.
- Never persist secrets, session tokens, or PII in STATE.

### Year-freezing (and similar immutability tricks)

- **Use when historical data is truly immutable.** Old Amazon orders from 2010 won't change.
- **Do NOT use when data retroactively mutates.** Refund status, delivery updates, review edits, chat-message reactions. If users depend on seeing the latest version of an old record, freezing is silently wrong.
- **Always include a "force re-scrape" escape hatch.** An env var, a manifest option, or a well-documented state-edit procedure. When a bug in record-parsing is found, you need to re-process existing data; frozen records fight you.

### Freeze-once-stable

If using year-freezing or any "freeze on second stable observation" pattern, document *why*: what's the platform contract that lets you trust immutability?

---

## 7. Rate-limiting and politeness

- **Sleep between navigations.** The exact numbers come from what the platform tolerates, not from what you can get away with. `1500ms` is a reasonable default for banking, `800ms` for e-commerce; adjust after observing.
- **Respect captcha as a first-class signal.** Don't retry through a captcha; that makes things worse. Emit `SKIP_RESULT reason=captcha` and stop.
- **Distinguish retryable from non-retryable errors in DONE.** `retryable=true` for network hiccups, DNS, 5xx. `retryable=false` for logical errors (unknown layout, auth failure that's not rate-limit).
- **Log rate-limit hits distinctly.** "HTTP 429" is diagnostic; "connection failed" is not.

### TOS and ethics

- Connector code lives alongside clear documentation of what data it reads, why, and whose account it targets (the owner's own).
- No connector should ever read data not owned by the calling user.
- If a platform's TOS specifically prohibits scraping, document that in the connector header and explain the user's legal basis (GDPR right of access, CCPA, etc.) for bypassing it.

---

## 8. What to capture, what to skip

### Stream scope

- **Canonical IDs over display strings.** `asin`, `order_id`, `message_id`, `transaction_id`. Display strings are for users, not for programmatic consumers.
- **Prefer platform-provided fields.** If the platform shows "delivered on Monday, April 20", capture that as the raw string; don't try to convert to your own date format at scrape time.
- **Don't capture UI cruft.** "Buy it again" buttons, "View your item" anchors, sustainability banners, "Customers who bought" carousels. These live in the DOM around the real data and will leak into your records if you're not careful.

### Stream design

- Stream names should map to what the platform itself calls things. `orders`, not `purchases`. `messages`, not `conversations`. The user recognizes the platform's own vocabulary.
- Prefer thin streams over fat streams. `orders` + `order_items` (two streams) is easier to query than one combined `orders_with_items` stream. Cross-joins are easy at query time; splits are hard.
- Declare every stream in the manifest, even if the connector can only partially populate it today. Manifest-declared, connector-null is better than manifest-silent.

---

## 9. Testing (given the constraints)

Connectors are hard to unit-test because they depend on live third-party surfaces. Accept that and aim for:

- **Fixture a handful of representative DOM snapshots** per connector. Enough to cover layout variants the author encountered. Use the capture infrastructure — see §9.1.
- **Run shape-check assertions on every emit** in production. These replace the unit tests you can't write.
- **Spot-check output manually.** After a new connector's first full run, eyeball 5-10 random records against the platform's own UI.
- **Record a "known failure modes" log** in the connector's design note. When Amazon renames a field, that's a datapoint for the next time.

### 9.1 Capturing fixtures from a live run

Live runs are the only opportunity to snapshot real DOM/API shapes. Every live run should capture fixtures as a byproduct — future parser tests depend on it.

**How it works**

Every connector using `runConnector()` gets capture automatically when `PDPP_CAPTURE_FIXTURES=1` is set. Captures go to `packages/polyfill-connectors/fixtures/<connector>/raw/<runId>/`:

- `records/<stream>.jsonl` — every emitted RECORD.data (free, auto-captured by the runtime's wrapped emit)
- `dom/<label>.html` — Playwright DOM snapshots, when the connector calls `capture.captureDom(page, label)` at parse checkpoints
- `http/<nnnn>-<label>.json` — HTTP response bodies, when an API connector calls `capture.captureHttp(label, body, meta)`

**Opting into DOM / HTTP capture from a browser connector**

```js
runConnector({
  name: 'amazon',
  browser: { profileName: 'amazon' },
  async collect({ page, capture, emitRecord }) {
    await page.goto('https://…/orders');
    if (capture) await capture.captureDom(page, 'orders-list-page-1');
    // parse and emitRecord as usual
  },
});
```

The `capture` handle is `null` unless `PDPP_CAPTURE_FIXTURES=1`. Guard with `if (capture)` or use optional chaining (`capture?.captureDom(…)`).

**Scrubbing before commit**

Raw fixtures contain your real PII — emails, addresses, order IDs, account numbers. Never commit `raw/`. Run the scrubber:

```bash
pnpm exec tsx bin/scrub-fixtures.ts <connector>
```

This applies the shared defaults in `src/scrub-defaults.ts` (emails, SSNs, credit-card-shaped digit runs, US phone numbers, labeled account numbers, deterministic street-address patterns, and labeled names) plus any connector-specific rules in `connectors/<connector>/scrub-rules.ts`. Output lands in `fixtures/<connector>/scrubbed/<runId>/`, which **is** committable after review.

For free-form text that deterministic rules cannot classify safely, use an LLM or human reviewer to produce a structured redaction plan, then pass it to the scrubber:

```bash
pnpm exec tsx bin/scrub-fixtures.ts <connector> <runId> --llm-redactions-dir ./local-redactions/<connector>
```

The scrubber does not call a network API. It only consumes one reviewed plan file per raw fixture, named after the raw relative path with `.redactions.json` appended, for example `dom/orders-list.html.redactions.json`:

```json
{
  "version": 1,
  "redactions": [
    {
      "text": "Alice Example",
      "replacement": "[REDACTED_NAME]",
      "reason": "person name in delivery status"
    }
  ]
}
```

This mode is fail-closed: every raw file must have a plan file, every replacement must be a `[REDACTED_*]` placeholder, and every target string must still exist after deterministic scrubbing. If any plan is missing, invalid, or stale, the run exits before writing that run's scrubbed output.

**Connector-specific scrub rules**

Create `connectors/<name>/scrub-rules.ts` exporting an array:

```js
export const scrubRules = [
  // Amazon-specific: order IDs are non-sensitive but authors may want stable values
  { pattern: /\b\d{3}-\d{7}-\d{7}\b/g, replacement: '111-2222222-3333333', scope: 'all' },
  // Reddit-specific: usernames
  { pattern: /u\/[A-Za-z0-9_-]+/g, replacement: 'u/anon', scope: 'all' },
];
```

Scope is `'all'` (every file type), `'html'`, or `'json'`. Rules run in order; defaults apply first.

**Before committing scrubbed fixtures**

Review the scrubbed tree by eye. The default rules are conservative but not exhaustive — for example, free-form notes, merchant names, unlabeled people names, and platform-specific IDs may not be caught by defaults. Add connector-specific rules for any pattern you find in review.

Confirm the scrubbed fixture preserves parser-relevant structure before commit: selectors, object keys, stream names, timestamps that are safe to retain, and representative non-sensitive values should remain stable. Redact or replace all owner identifiers, free-form notes, account numbers, addresses, emails, phones, and platform IDs that can identify the owner. If review finds sensitive content the deterministic scrubber cannot safely classify, do not commit the fixture until a connector-specific rule or reviewed manual redaction covers it.

When committing a pilot fixture, commit only `fixtures/<connector>/scrubbed/<runId>/...` and tests that consume it. Do not commit `fixtures/<connector>/raw/...` or local redaction-plan directories; keep those local unless a plan itself is synthetic and intentionally useful as test data.

**Smoke-test the capture pipeline**

`pnpm exec tsx bin/test-fixture-capture.ts` runs a self-contained end-to-end check (no network, no browser) that capture + scrub produce sanitized output from PII-bearing input. Run it after changing anything in `fixture-capture.ts`, `scrub-defaults.ts`, or `scrub-fixtures.ts`.

### Pre-ship checklist

Before a new connector is considered usable by another user:
- [ ] Runs end-to-end on at least one owner account (the author's).
- [ ] Emits shape-check assertions for every field that can go wrong.
- [ ] Declares all streams in manifest, even nullable ones.
- [ ] Has a SKIP_RESULT path for selector drift (list page returning zero records is a drift signal, not a "no data" signal).
- [ ] Documents locale / account-type assumptions in the connector's header comment.
- [ ] Has been run at least twice (so incremental/STATE behavior is exercised).

---

## 10. Versioning and drift

- Connector version is declared in the manifest. Bump it when schemas change, when selector strategies change materially, or when STATE cursor shape changes.
- Keep a short `CHANGES` section in the connector's header comment (or adjacent `.md`) noting "v0.3 — switched item extraction from innerText-regex to data-component (2026-04-21)". Future readers will thank you.
- When selectors break (inevitably they will), resist the urge to silently edit them. Bump the connector version; commit with a message that names the drift observed.

---

## 11. Locale and account-type honesty

A connector that works on the author's account does not automatically work on another account, and definitely does not work across locales. Be honest in your connector header about what you've tested:

```
 * Tested surfaces (as of 2026-04-21):
 *   - US / EN consumer account, card-or-giftcard payment
 *   - Orders 2005-2025, ~1,200 orders
 *
 * Known untested:
 *   - EU / non-EN locales
 *   - Business / Prime Student accounts
 *   - Non-card payments (PayPal, Affirm, etc.)
```

This is not a TODO list; it's a contract. It tells the next user whether to trust the connector for their case.

---

## 12. Blob hydration (file/attachment bytes)

When a stream carries binary payload (attachments, statement PDFs,
uploaded files, message media), don't inline bytes into records and
don't invent a stream-specific download URL. The contract is fixed:

1. The connector fetches bytes from the source while operating under
   the owner-authorized session it already holds (IMAP, signed Slack
   token, scrape session, on-disk filesystem path).
2. The connector uploads bytes to the reference RS via
   `POST /v1/blobs?connector_id=…&stream=…&record_key=…`. The RS
   stores them content-addressed (sha256) and returns a `blob_ref`.
3. The connector emits a record whose `data.blob_ref` carries
   `{ blob_id, mime_type, size_bytes, sha256 }`, plus
   `content_sha256` (mirrors the blob sha) and `hydration_status`.
4. Clients fetch via `GET /v1/blobs/{blob_id}`, reached through the
   server-injected `blob_ref.fetch_url`. There is no
   `/v1/streams/.../{id}/content` or `/v1/blobs/{id}/download`. Don't
   invent one in the manifest, the connector, or the docs.

### Manifest fields a hydratable stream needs

```json
{
  "blob_ref": {
    "type": ["object", "null"],
    "properties": {
      "blob_id":   { "type": "string" },
      "mime_type": { "type": "string" },
      "size_bytes":{ "type": "integer" },
      "sha256":    { "type": "string" }
    },
    "required": ["blob_id", "mime_type", "size_bytes", "sha256"],
    "additionalProperties": true
  },
  "content_sha256":    { "type": ["string", "null"] },
  "hydration_status":  { "type": "string", "enum": ["hydrated","failed","deferred","too_large"] },
  "hydration_error":   { "type": ["string", "null"] }
}
```

Add other status enum values (`unavailable`, `blocked`, `skipped`)
**only when your connector actually exercises that branch**. Pre-adding
unreachable values lies about observable behavior.

### Reference implementation (Gmail)

The shipped reference is `connectors/gmail/index.ts`:

- `enforceMaxBytes(content, maxBytes)` — generator wrapper that throws
  when a stream's running byte count exceeds the cap. Reuse this — do
  not re-implement it.
- `makeReferenceBlobUploader({ ownerToken, rsUrl })` — creates the
  streaming upload body, computes sha256 inline, posts to `/v1/blobs`,
  parses the typed response. Reuse this for any
  `AsyncIterable<Buffer | Uint8Array | string>` source.
- `attachmentWithHydrationFailure(attachment, status, err)` — preserves
  metadata, sets `blob_ref: null`, sets `hydration_status`, and applies
  `boundedHydrationError` (240-char truncation).

### Size policy

Pick a conservative default aligned with the source's per-item cap.
Expose an operator override env var (e.g.
`PDPP_<CONNECTOR>_MAX_<ARTIFACT>_BYTES`). Enforce **twice**: once
before download (against the upstream-reported `size_bytes`) and once
during streaming (against under-reported sources) via
`enforceMaxBytes`. Both checks have to be present; only one is a bug.

### Failure handling

- Always emit a metadata-only record with a truthful `hydration_status`
  when bytes are unavailable — never silently drop the row.
- `hydration_error` is **public** (it's a record field). Never put
  signed URLs, tokens, file paths that leak filenames, or full stack
  traces in it. Use `boundedHydrationError` to truncate.
- Connectors that download via signed URLs MUST scrub query strings
  before populating `hydration_error`. Gmail's IMAP path has no such
  risk; signed-URL connectors do.

### Idempotency

Re-running a connector on the same attachment must produce the same
`blob_id` and not duplicate bytes. The reference RS gives you this
for free via content-addressed `INSERT OR IGNORE` on sha256. Don't
add per-connector dedup logic; trust the substrate.

### Current hydration status (2026-04-26)

- ✅ **Shipped**: `gmail.attachments` (vertical slice).
- ⏳ **Deferred follow-ups** with focused design notes under
  `openspec/changes/hydrate-first-party-blob-streams/design-notes/`:
  - `slack-blob-followup-2026-04-26.md` (slack `files`, `canvases`)
  - `financial-statement-blob-followup-2026-04-26.md` (chase, usaa
    `statements`)
  - `commerce-receipt-blob-followup-2026-04-26.md` (amazon and other
    commerce invoices)
  - `assistant-artifact-blob-followup-2026-04-26.md` (chatgpt,
    claude_code, codex, imessage, whatsapp)
  - `source-host-blob-followup-2026-04-26.md` (github gists,
    pr_artifacts)
  - `social-media-blob-followup-2026-04-26.md` (reddit, meta,
    twitter_archive, loom)
- 📋 The full audit table is in
  `blob-hydration-coverage-2026-04-25.md` in the same directory.

Pick from the deferred list before adding bytes to a connector that
isn't on it; if your connector isn't covered, update the audit table
in the same PR.

---

## Appendix A: Known failure modes across our connectors

(Accumulate as observed. Each entry is a teaching moment for future authors.)

- **Amazon 2026-04-21**: Item rows where `innerText` begins with a digit (product titles like "2015 New Version..." or "100 Sheets...") caused a leading-digit regex to extract the digit as quantity. Fixed by switching to a DOM-selector (`.od-item-view-qty span`) for quantity. Lesson: never parse quantity out of concatenated text when the platform has a dedicated element for it.
- **Amazon 2026-04-21**: "Customers Who Bought" recommendation cards render inside the same `.a-box` hierarchy as shipment items, and contain `"Sold by"` in some child text. Cross-sell rows leaked into `order_items` until the cross-sell regex was broadened to match casing variants. Lesson: "contains 'Sold by'" is not a reliable shipment-item marker; structural siblings matter.
- **USAA 2026-04-19**: Chromium dropped session cookies on process exit, breaking every re-run. Fixed by introducing the long-lived browser daemon. Lesson: banking sites use session cookies (no Expires) for actual auth tokens.
- **Chase 2026-04-20**: Selectors needed Shadow DOM piercing (`getByRole('option')` + `text=` on `mds-*` Web Components) because the bank uses Material Design Shadow web components. Lesson: don't assume flat DOM.
