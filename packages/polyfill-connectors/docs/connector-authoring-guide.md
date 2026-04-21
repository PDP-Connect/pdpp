# Connector authoring guide

This document captures the standards, heuristics, and earned lessons for writing polyfill connectors in this package. It is prescriptive: if you're writing a new connector or auditing an existing one, treat this as the floor, not the ceiling.

The guide is written for connector *authors*. It does not describe the Collection Profile wire protocol (that's in `spec-collection-profile.md`) or the Polyfill Runtime (that's in `spec-polyfill-runtime.md`). It describes how to write the code between those two layers.

## Standard dependencies (as of 2026-04)

Use these libraries by default. They are chosen because they are actively maintained and are the community defaults in 2026:

- **`patchright`** — Playwright drop-in with bundled Chromium stealth patches (Runtime.Enable, Console.Enable, and others). Replaces `rebrowser-playwright` which went stale in mid-2025. The maintainer tracks upstream Playwright within days. `launchPersistentContext` with `channel: "chrome"` is the recommended launch path; do not override args or userAgent except for specific workarounds (e.g. the DownloadBubble bug).
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

All new scraping connectors should use `acquireIsolatedBrowser({ profileName: '<connector>' })` from `src/browser-daemon.js`. This:

- Launches patchright-patched Chrome per connector run (full stealth: launch-side AND client-side).
- Uses a persistent profile directory at `~/.pdpp/profiles/<connector>/`, so cookies, localStorage, and trusted-device state persist across runs of that connector.
- Is isolated from other connectors (different profile dir = different fingerprint, different cookies, no cross-contamination).
- Supports concurrent runs across connectors (each connector has its own browser process; no lockfile).

Do **not** use the legacy `acquireBrowser()` daemon path for new connectors. The daemon exists for backwards compatibility with connectors not yet migrated, but its CDP-attach architecture forfeits patchright's client-side stealth (the patches that run on `evaluate`/`locator` calls, not just at browser launch). The daemon will be retired once all connectors are migrated.

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

## 5. Session-state pattern

- **Probe before login.** A cheap auth check before driving credentials saves rate-limit budget and human patience.
- **Login before challenge.** Drive credentials from env/secrets. If a challenge (OTP, 2FA, SMS) fires, emit `INTERACTION kind=otp` and block until the orchestrator forwards the code.
- **Never assume a human is present.** A connector running unattended at 3am must either complete or emit a clear INTERACTION; it must not hang, retry indefinitely, or produce partial output.
- **Session elevation is a thing.** Some platforms (Amazon Privacy Central) require a *recent* password entry even for logged-in sessions. Handle these distinct from "session dead".
- **Cookie longevity varies.** Chromium drops session cookies on exit. If the platform uses session cookies for auth (USAA, Amazon), use the long-lived browser daemon (`src/browser-daemon.js`). Otherwise launchPersistentContext is fine.

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

- **Fixture a handful of representative DOM snapshots** per connector. Enough to cover layout variants the author encountered.
- **Run shape-check assertions on every emit** in production. These replace the unit tests you can't write.
- **Spot-check output manually.** After a new connector's first full run, eyeball 5-10 random records against the platform's own UI.
- **Record a "known failure modes" log** in the connector's design note. When Amazon renames a field, that's a datapoint for the next time.

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

## Appendix A: Known failure modes across our connectors

(Accumulate as observed. Each entry is a teaching moment for future authors.)

- **Amazon 2026-04-21**: Item rows where `innerText` begins with a digit (product titles like "2015 New Version..." or "100 Sheets...") caused a leading-digit regex to extract the digit as quantity. Fixed by switching to a DOM-selector (`.od-item-view-qty span`) for quantity. Lesson: never parse quantity out of concatenated text when the platform has a dedicated element for it.
- **Amazon 2026-04-21**: "Customers Who Bought" recommendation cards render inside the same `.a-box` hierarchy as shipment items, and contain `"Sold by"` in some child text. Cross-sell rows leaked into `order_items` until the cross-sell regex was broadened to match casing variants. Lesson: "contains 'Sold by'" is not a reliable shipment-item marker; structural siblings matter.
- **USAA 2026-04-19**: Chromium dropped session cookies on process exit, breaking every re-run. Fixed by introducing the long-lived browser daemon. Lesson: banking sites use session cookies (no Expires) for actual auth tokens.
- **Chase 2026-04-20**: Selectors needed Shadow DOM piercing (`getByRole('option')` + `text=` on `mds-*` Web Components) because the bank uses Material Design Shadow web components. Lesson: don't assume flat DOM.
