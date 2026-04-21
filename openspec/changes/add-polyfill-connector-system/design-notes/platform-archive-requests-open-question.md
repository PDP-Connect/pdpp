# Open question: platform archive-request flows as a data source

**Status:** open (partial implementation in `bin/amazon-request-export.mjs` covers the request-kickoff step only; ingest path remains open)
**Raised:** 2026-04-21
**Trigger:** While making the Amazon connector's `orders` and `order_items` streams pristine via DOM scraping, the ~1,181-order backfill projected to 2–3 hours of detail-page navigations. This prompted the question of whether Amazon (and peer platforms) expose any non-scrape path for bulk personal data. The answer is that they expose a GDPR/CCPA "archive request" path — a form the user submits, a zip the platform delivers by email 1–30 days later — but PDPP connectors today only use the DOM-scrape path. That gap is the subject of this note.

## What exists today in the field

Most consumer platforms expose at least one of the following surfaces for personal data:

- **Live web DOM.** A logged-in user can browse their own records. This is what our Playwright connectors read.
- **Live API.** A small number of platforms expose stable OAuth APIs (YNAB, Oura, Strava, Spotify). Our connectors use these where available.
- **Archive-request flow.** A compliance surface introduced or expanded around GDPR (2018) and CCPA (2020). The shape is consistent across platforms: user submits a request, platform prepares a zip, delivers a download link via email, link is valid for some window (typically 14–30 days), zip is a heterogeneous bundle of CSVs, JSON, and media files.

Observed examples of archive-request flows on platforms already in our manifest directory:

| Platform | Entry point | Observed latency | Observed format |
|---|---|---|---|
| Amazon | Privacy Central (`/hz/privacycentral/data-requests/preview.html`) | 1–30 days | zip of CSV per category |
| Google | Google Takeout (`takeout.google.com`) | 1 hour – several days | zip of mixed CSV/JSON/mbox |
| Meta (FB/IG) | "Download Your Information" | hours – days | zip of JSON |
| Twitter/X | Archive request in Settings | 1–30 days | zip of JSON |
| Apple | `privacy.apple.com` | 7+ days | zip, category-split |
| Spotify | Account → Privacy | ~30 days | zip of JSON |
| LinkedIn | "Get a copy of your data" | 1+ days | zip of CSV |
| Reddit | `reddit.com/settings/data-request` | 30+ days | zip of CSV |

None of our connectors currently use this surface. All of them use either live DOM or live API.

## What the spec says today

Collection Profile and Polyfill Runtime docs describe a connector run as:
- Reads `START` from stdin, writes JSONL to stdout.
- Is bounded in wall-clock time — runtime declares timeouts, retries, cursor semantics.
- May emit `INTERACTION` messages that block until a response arrives (OTP, manual action).
- Completes with `DONE`.

The spec doesn't forbid an archive-request workflow, but it doesn't describe one either. Open questions the spec leaves unanswered for this case:

- A connector run that kicks off a data request and then waits 30 days is not bounded in wall-clock time in any sensible way. Nothing in the spec says how that should be represented.
- A connector run that accepts a file (zip) as input — from the user's filesystem, not from a live platform — has no defined input surface. `INTERACTION` carries JSON-schema-validated responses; a pointer to a 4 GB zip isn't that.
- Streams populated from an archive-request path and streams populated from a scrape path might share a `connector_id` or might not. Either answer has consequences for UPSERT semantics, stream-count reporting, and the RS's query shape.

## Why this keeps coming up

Three drivers:

1. **Archive paths cover streams scraping doesn't.** Amazon's zip includes (per spot inspection of a prior-year export): orders, returns, reviews, addresses, digital orders, browsing history, Alexa transcripts, wishlist, search history. A scrape-only connector that covers `orders` + `order_items` is missing most of what the platform stores. Every additional stream added via scraping requires a new DOM parser. Archive paths cover all of them at once.

2. **Archive paths are more robust to UI churn.** Platforms rewrite their web UI on A/B-test cadence. Archive zips change format on a much slower cadence (years), because they're documented as the official "your data" interface and have regulator-facing compliance obligations.

3. **Archive paths are legally durable.** A platform can remove its web export tool (Amazon did in 2023 for Order Reports) without legal consequence, but it cannot remove the GDPR/CCPA archive path. This affects the connector's long-term maintenance risk profile.

Against those:

- Archive paths are high-latency. A user who wants recent activity (purchases this week, messages today) can't wait 30 days.
- Archive paths are rate-limited. Amazon caps consumer data requests at approximately one per 30 days per category. A failed or corrupted delivery blocks the retry for weeks.
- Archive paths deliver data at once, not incrementally. There is no cursor; the zip is a full snapshot. Incremental updates require a second modality.
- Archive zips contain personal data well beyond any single stream — browsing history, voice recordings, contacts lists. Consent surfaces that say "connect your orders" may under-represent what an archive import actually pulls in.

## Design questions that a future resolution would need to answer

These are the concrete forks a resolution would need to commit to. Each has real-world precedent in one direction or another; listing them is not an argument for any particular choice.

### 1. Is archive-request a connector capability, an orchestration capability, or a new primitive?

- **Capability of an existing connector.** The Amazon connector learns to do both DOM-scrape and archive-ingest under the same `connector_id`. Mode is selected at run time (env, START field, or autodetect).
- **A separate connector per platform per mode.** `amazon-scrape` and `amazon-archive` as distinct manifests, possibly distinct `connector_id`s. Client or user picks one.
- **A new primitive in the Polyfill Runtime.** The runtime gains first-class "data request" lifecycle support (submit → wait → ingest) independent of the connector's per-stream emit loop.

### 2. How does a multi-day wait interact with a "bounded run"?

- Single run with long poll. Breaks if the orchestrator process dies.
- Multiple runs with durable state carrying the request ID. How STATE represents "request pending, not yet ingestible" is not covered by today's cursor shapes.
- Out-of-band completion. Connector exits after kickoff; a separate event (webhook, file-system watcher, user action) triggers ingest.

### 3. How does a zip get into the connector?

- Path on the filesystem, declared via env or CLI flag.
- Uploaded through the dashboard, stored in a blob, referenced by blob ID.
- Extracted from the platform automatically (connector polls download link, downloads when ready).
- Downloaded by the user, handed to the connector through a new `INTERACTION kind`.

### 4. How do archive-sourced records interact with scrape-sourced records?

- If same `connector_id`: UPSERT on `(connector_id, stream, record_key)` naturally merges. Requires stable record keys across sources.
- If different `connector_id`: dedup is pushed to the caller at query time. Simpler for the RS, harder for consumers.
- If streams are partitioned by source: archive populates stream set A, scrape populates set B, no overlap. Requires manifest-level declarations of which streams each mode produces.

### 5. Should the consent surface distinguish modes?

- Archive-request flows pull more personal data than any scrape ever would (browsing, voice, etc.). A connector manifest that declares both modes needs a consent UI that makes the breadth difference legible to the user.
- Today's consent cards describe streams by name, not by source or modality. Expanding them to include modality is a spec-adjacent change.

### 6. Does this belong in the Polyfill spec at all, or downstream of it?

- Collection Profile is transport + schema. Neither transport nor schema is affected by archive ingest vs. scrape ingest — records look the same downstream.
- Polyfill Runtime is process lifecycle. Multi-day waits and file-based input are lifecycle questions the runtime does address (via `INTERACTION`, state persistence, etc.) but doesn't currently generalize to this shape.
- A real-deal (non-polyfill) PDPP implementation — a platform that natively speaks PDPP — wouldn't have archive-request as a mode at all. This is a polyfill-era concern, which might argue for keeping the resolution in Polyfill Runtime rather than escalating it to the core spec.

## What we know from the Amazon case specifically

- The Amazon DOM-scrape path for `orders` + `order_items` works. It produces ~1,181 orders in ~2–3 hours of unattended runtime on a single account and ~1,680 items with price/qty/seller fields populated.
- The Amazon archive zip (observed on a prior-year export by a team member) contains `Retail.OrderHistory.*.csv` with per-line-item fields including many that our scrape cannot extract from the list page (e.g. payment method tokens, tax breakdowns, seller full addresses). It also contains ~30 other CSV/JSON files representing other streams.
- Amazon's archive request is email-gated and rate-limited at approximately one per 30 days per category.
- Amazon's Privacy Central data-request page is at `https://www.amazon.com/hz/privacy-central/data-requests/preview.html` and forces a re-auth challenge even for logged-in sessions (observed 2026-04-21 — the URL 302s to `/ap/signin` with an `openid.pape.max_auth_age=600` parameter, indicating Amazon treats it as a high-sensitivity operation). The re-auth prompts only for password (email is pre-selected from the daemon's session); 2FA follows on some challenges. Satisfying the re-auth elevates the session for ~10 minutes.
- The Privacy Central form exposes one submit button per category (`Submit Request <Category Name>`), plus an "all-categories" button (`Submit Request Request All Your Data`). No category IDs or form names — buttons are reachable only by text match. 17 categories as of 2026-04-21 (orders, addresses, payment options, subscriptions, search history, Echo+Alexa, Kindle, Fire TV, Fire Tablets, advertising, Photos+Drive, apps, music, Prime Video, Audible, support, and the all-of-it bucket).
- No connector in the current manifest set consumes an archive zip.

## Breadcrumbs in code

Work in progress that future-us or a successor implementer will run into:

- `packages/polyfill-connectors/bin/amazon-request-export.mjs` — standalone CLI utility for the request-kickoff step. Attaches to the browser daemon via CDP (doesn't block the lock), navigates to Privacy Central, drives the re-auth challenge, snapshots the form, and (with `--submit --category <name>`) clicks the category's submit button. Explicitly does NOT handle email verification, download-link retrieval, or zip ingest — those remain open.
- `packages/polyfill-connectors/bin/amazon-privacy-probe.mjs` — URL-discovery probe used to locate the Privacy Central entry point. Retained as reference material.

### What's exercised end-to-end today

- Daemon attach via CDP (reuses the warm, logged-in Amazon session from any running connector).
- Re-auth challenge handling (password-only; 2FA interactive via stdin).
- Form snapshot (no submit) — safe to run anytime, even during an active backfill.
- **Live submission of `--submit --category all`** (verified 2026-04-21 on the owner's account):
  - Each of 17 categories is its own `<form method="post" action="/hz/privacy-central/data-requests/create.html?data-category=<slug>">` with a single hidden `anti-csrftoken-a2z` input. No reCAPTCHA on the page, no JS-intercepted submit, no modals.
  - POST to the `create.html` endpoint returns HTTP 200 and a page titled "Data Request Creation" with body text "Thank You. You're almost done... We've sent a confirmation link to your email which you will need to click in order to verify your request. Please note, this link will expire in 5 days."
  - The confirmation link is emailed to the account email and must be clicked within 5 days or the request dies (rate-limit cooldown presumably still applies).

### What is NOT exercised today

- Email verification click — Amazon emails the confirmation link; the script explicitly leaves this step to the user. To automate: we'd need IMAP/Gmail API access to the account email + a parser to find the link + a Playwright click. See "Email as an automation surface" below.
- Zip-download retrieval — after email verification, Amazon emails a second link days later pointing to the zip download. Same email-access requirement as above.
- Zip ingest — the open question.
- Rate-limit error handling — we've never seen Amazon's response when the 30-day cap is hit.
- Multi-account validation — one account, US locale, English. EU/GDPR variants unprobed.
- Repeat-submission idempotency — what happens if we re-submit "all" while a prior request is pending verification or in flight.

### Verification URL shape (observed 2026-04-21)

Amazon's email confirmation link is a signed URL:

```
https://www.amazon.com/hz/privacy-central/data-requests/confirm.html
  ?requestId=<uuid-v4>
  &signature=<64-char-hex>
  &ref_=<tracking-token>
```

Clicking the link returns a page with the string "We've received and are processing your request to access your personal data." The `signature` field is an HMAC that cannot be reconstructed client-side — the link must be extracted from the email. This structural constraint makes email access a hard requirement for end-to-end automation of this path.

### Email as an automation surface

A separate open question surfaced 2026-04-21 during the Amazon submission flow: **what role should server-side email access play in PDPP's polyfill runtime?**

Observed context:

- Amazon's data-request confirmation flow is email-gated (signed link the user must click).
- Amazon's zip-delivery flow is email-gated (signed link to the download).
- Multiple other platforms use email-gated flows for analogous actions (Google Takeout completion notifications, Meta DYI delivery, Apple privacy exports, etc.).
- Our `gmail` connector already reads the user's email via IMAP, so the credential pattern exists.
- Using the user's existing email connector credentials to drive archive-request follow-up would collapse the human-in-the-loop step to zero for users who have already connected their email.

This is not a spec-level question (the Collection Profile doesn't care how a connector gets its data). It's a Polyfill Runtime question about whether connectors can compose with each other's credentials — specifically whether "connector A can programmatically access resources unlocked by connector B's grant" is a supported pattern. Today the answer is effectively no: each connector is a sandboxed subprocess reading its own env vars.

Design forks, listed without recommendation:

- **Shared credential store.** Connectors that need email access declare it in manifest; the runtime injects the appropriate env vars at START time, gated by the owner's consent to share.
- **Email-as-a-connector-as-a-capability.** The `gmail` connector (or a sibling) exposes a narrow internal API that other connectors call to fetch messages matching a pattern. Runtime mediates.
- **Email ingest as a stream in its own right.** Rather than having Amazon call Gmail, Amazon treats "emails from amazon-privacy@amazon.com containing data-request links" as an input stream it subscribes to. This collapses the composition question into the normal stream-read path.
- **Out-of-band user action.** Keep the email-click step manual. Document the limitation. Eventually platforms may offer non-email completion paths (webhook, polled API).
- **Integrate with a hosted mail service.** Instead of requiring IMAP/Gmail-API access to a real user inbox, route the request-initiation to a disposable address the server owns. Amazon emails the disposable address; the server parses and completes.

Each has different privacy, auth, and composition consequences. Defer to a dedicated note if this blocks enough future connectors to warrant the digging.

## Related open questions

- `connector-configuration-open-question.md` — user-authored vs manifest-authored config; archive mode vs scrape mode would share this surface.
- `credential-bootstrap-automation-open-question.md` — archive requests need live auth at request time; subsequent download links may need re-auth.
- `gap-recovery-execution-open-question.md` — archive ingest could be one vector for filling gaps detected by cursor-finality checks.
- `partial-run-semantics-open-question.md` — an ingest that covers some streams and not others has the same taxonomy questions as a scrape that partially succeeds.
- `raw-provenance-capture-open-question.md` — archive zips are themselves primary-source artifacts; whether to retain the zip alongside the parsed records is a provenance question.
