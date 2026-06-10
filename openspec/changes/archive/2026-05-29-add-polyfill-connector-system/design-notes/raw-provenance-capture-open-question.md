# Open question: raw-provenance capture — should connectors preserve re-extractable artifacts?

**Status:** open
**Raised:** 2026-04-19
**Trigger:** Fixing a ChatGPT extractor bug that dropped 67% of message content for non-text `content_type`s required re-scraping the backend API — hitting 429s over hours — because raw responses were never stored. Same day, filling in previously-unfetched Gmail bodies meant IMAP-scraping 17k messages again (20–30 min). the owner's pushback — "how do you define raw upstream responses for some of this? Like, the entire DOM?" — is the actual spec-surface question. "Store raw" is clean for APIs and files, messy for browser scraping.

## Why this is a spec-level question

Re-extraction cost, audit fidelity, and self-export completeness all pivot on whether the RS holds the upstream artifact or only the parsed record. Owners who self-export raw receive something qualitatively different from owners who receive only the extractor's output: raw is auditable against the source and re-parseable when the extractor improves; the parsed record is frozen at whatever shape the extractor happened to produce on ingest day.

## Two motivations, both valid

The "store raw" question has two independent drivers that people sometimes conflate:

### Motivation A — developer-facing (re-extraction, debugging, audit)

The one I framed this note around. When the extractor improves, we re-parse stored raw instead of re-scraping. When something looks wrong in a parsed record, we inspect the raw to see whether the bug is in extraction or the upstream. When an auditor asks "prove this record faithfully represents the source," we hand them the raw.

### Motivation B — owner-facing (raw as the primary artifact)

Raised by the owner 2026-04-19 while discussing USAA's 7-year statement-PDF archive:

> "if we parse pdf statements we might as well keep the pdfs for owner reference"

USAA's 20-year-old account has monthly PDF statements going back potentially decades. Even after we parse those into itemized transaction records, the PDFs themselves have **owner-facing value**:

- They look like "my bank statements" — recognizable, familiar, printable.
- They carry signatures, branding, layout context that the parsed rows don't.
- They're what the owner would want to hand a CPA, a mortgage underwriter, a lawyer.
- They're irrevocable evidence-of-record in a way that parsed rows aren't.

**Same pattern across other connectors:**
- Gmail message bodies / full `.eml` — "show me that email from 2015" as the original, not just extracted headers + body_text.
- Original Slack export archive — "the Slack workspace as it existed on date X."
- PDF tax documents from employers, brokerages, utility companies.
- Original photo binaries (Apple Photos, Google Photos) — the raw JPEG, not just EXIF metadata.
- Original audio/video — podcasts, voice memos, voicemails.

The owner perspective flips the cost-benefit: storage isn't debug overhead, it's **the thing they actually want.** A self-export artifact containing 20 years of original PDF statements is more valuable than one containing only parsed rows; same with photos, emails, voice recordings.

## How Motivation A and Motivation B interact

If a connector's raw is stored for Motivation A (debugging), Motivation B falls out for free — owners can access the same raw via self-export. And vice versa: storing the raw for owner reference gives us a free re-extraction path.

**Practical consequence:** connectors that store raw should store it **once**, and both motivations use the same storage. Don't split into two separate tracks. The real design question is: what's the storage interface that serves both cleanly?

## What "raw" means per connector class

| Class | Re-extractable artifact | Clean or Messy |
|---|---|---|
| REST API (YNAB, GitHub, ChatGPT backend-api, Oura) | Response JSON per endpoint per record | Clean |
| File import (Claude Code jsonl, Codex rollouts, Google Takeout, WhatsApp) | The source file (already on disk) | Clean |
| IMAP (Gmail) | RFC822 message source | Clean |
| SQLite/subprocess (Slack via slackdump, iMessage `chat.db`) | The tool's archive file | Clean |
| Browser scraping of client-rendered pages (USAA, Amazon, LinkedIn) | HAR + DOM snapshot | Messy |
| Browser scraping of SSR pages | HTML + URL + timestamp | Semi-clean |
| OAuth API with short-lived signed URLs (Slack file bytes, Gmail attachment blobs) | Varies | Case-by-case |

Browser-scrape raw is technically possible (Playwright HAR + DOM save) but large (JS bundles, CSS, ads) and won't fully replay — JS hydration depends on live browser context.

## What the spec could require

### Option A — Mandate raw capture for all connectors
Every connector MUST store raw artifacts. Operators pay storage; gain re-extraction.
- Pro: bulletproof auditability; free extractor iteration.
- Con: storage blowup (Gmail RFC822 ≈ 10–50× parsed); privacy surface (raw may contain fields extraction deliberately stripped); browser-scrape is fundamentally messy.

### Option B — Per-class conventions, manifest-declared policy
Manifest declares `provenance_policy: "api_json" | "file_passthrough" | "imap_rfc822" | "dom_har" | "none"`. Consumers/auditors can see at a glance what re-extraction requires.
- Pro: honest per-class; lets browser-scrape opt out explicitly.
- Con: new spec surface; taxonomy has to be enumerated; `"none"` degrades the guarantee silently.

### Option C — Optional opt-in `provenance_artifacts` sibling stream
A connector MAY declare a sibling stream keyed by `record_id`, storing raw blobs (hash-referenced from records). Extractors iterate by reading provenance instead of re-scraping.
- Pro: cleanest; composes with `blob-hydration-open-question.md`; storage/compute decoupled per-connector; no force.
- Con: voluntary; high-value connectors may still skip it.

### Option D — Silent: per-connector choice
Status quo. Auditors read source to understand what's stored.
- Pro: zero spec change.
- Con: every re-extraction pain is rediscovered from scratch.

## Trade-offs to weigh

- **Storage** — Gmail RFC822 ≈ 10–50× parsed records. Slack's archive is already raw (double-stored if PDPP also keeps raw). Browser-scrape DOM: 5–50 MB per page.
- **Privacy** — raw preserves material extraction was designed to strip (CC headers, hidden metadata, unsanitized HTML); self-export with raw is more sensitive than parsed.
- **Iteration velocity** — ChatGPT + Gmail re-scrapes repeat every time an extractor bug is fixed or a field is added.
- **Regulatory/audit** — "prove this parsed record faithfully represents the upstream source" is easy with raw, hard without.
- **Version lock-in** — stored raw is schema-frozen at capture time; extractors must handle drift as the source API shape changes over years.

## Cross-cutting

- `blob-hydration-open-question.md` — raw capture is a specific flavor of "binary artifacts attached to records."
- `layer-2-completeness-open-question.md` — "complete" coverage may require raw, for re-extractability.
- `credential-storage-open-question.md` — raw may contain credential-adjacent material needing vault-grade storage.
- `owner-self-export-open-question.md` — does self-export include raw? At what scope?
- `rs-storage-topology-open-question.md` — raw blobs may deserve a topology separate from records.
- `authored-artifacts-vs-activity-open-question.md` — authored artifacts lost without raw are irrecoverable; activity streams with raw can re-extract.

## Action items

- [ ] Inventory current state: slackdump captures raw; Claude Code / Codex / Takeout do naturally as file imports; API connectors (ChatGPT, Gmail, YNAB, GitHub, Oura) do not.
- [ ] Decide A / B / C / D with the Linux Foundation audience in mind (they care most about provenance rigor).
- [ ] If B or C: define the provenance taxonomy + field schema.
- [ ] Pilot on one API connector (ChatGPT is a candidate — we just learned the pain) before generalizing.
