# Design brief: binary content invariant for the PDPP reference implementation

**Status:** Implementation contract (revised 2026-05-11 after expert review).
**Author:** PDPP maintainers (via working session, 2026-05-11).
**Audience:** A third-party expert with zero PDPP context. Original draft requested adversarial review; this revision incorporates the expert's amendments as the implementation contract.
**Scope:** Storage protocol invariant for connector-emitted records, the schema-level enforcement mechanism, and the migration path for legacy data that violates the invariant.

> **Revision note (2026-05-11, post-expert review):** The original §5 listed open questions. The expert review resolved them. The revisions appear inline below, with a consolidated change log in §9. Sections 0–3 (context, evidence, taxonomy, existing helper) are unchanged.

---

## 0. What is PDPP, and why does this brief exist

PDPP (Personal Data Polyfill Protocol) is a reference implementation of an OAuth-2.1-extension protocol for human consent over personal data flows between data sources, "agents" (LLM-driven workflows), and clients. The implementation is split across:

- A **reference implementation** at `reference-implementation/` (Node.js, SQLite or Postgres backend, ~30 tables).
- A **connector package** at `packages/polyfill-connectors/` (TypeScript, currently 11 connectors: codex, claude_code, github, gmail, slack, chatgpt, reddit, amazon, chase, usaa, ynab).
- A **Next.js dashboard** at `apps/web/`.
- A normative **spec** at `openspec/specs/`.

A "connector" is an adapter that captures structured records from a data source (an email, a Slack message, a Codex session, a bank transaction) and emits them into PDPP's stream storage. Each connector is a TypeScript module that:

1. Pulls raw input from the data source (a JSONL file, an HTTP API, a parsed PDF, …).
2. Validates each record through a Zod schema declared in `connectors/<name>/schemas.ts`.
3. Emits the record into the `records` table via the storage layer.

The records table is the canonical store for stream payloads:

```sql
CREATE TABLE records (
  connector_id   TEXT NOT NULL,
  stream         TEXT NOT NULL,
  record_key     TEXT NOT NULL,
  record_json    JSONB NOT NULL,      -- (TEXT in SQLite, JSONB in Postgres)
  primary_key_text TEXT,              -- Postgres-only derived projection
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  -- (additional metadata columns elided)
  PRIMARY KEY (connector_id, stream, record_key)
);
```

Binary content (file contents, image bytes, attachment payloads) has a separate home, the **`blobs` table**, which is content-addressed by sha256 with a join table for back-references:

```sql
CREATE TABLE blobs (
  blob_id       TEXT PRIMARY KEY,
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  data          BLOB        -- BYTEA in Postgres
);

CREATE TABLE blob_bindings (
  blob_id       TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  PRIMARY KEY (blob_id, connector_id, stream, record_key),
  FOREIGN KEY (blob_id) REFERENCES blobs(blob_id)
);
```

This brief addresses a concrete incident: **131 records in the production-style SQLite database contain raw binary content (NUL bytes and other forbidden codepoints) inlined inside string-typed fields of `record_json`.** This is a connector implementation bug: those bytes should have been routed to the `blobs` table. The bug was harmless under SQLite (which permits NUL in text) but is fatal under Postgres JSONB (which rejects U+0000, SQLSTATE 22P05) and is the immediate blocker for the user's SQLite→Postgres migration.

The author is now asking: **what is the SLVP-ideal design for the underlying invariant, its schema-level enforcement, and the migration of the legacy 131 records?**

"SLVP" is the owner's internal shorthand for the quality bar: **"Simplest Lossless Verifiable Path"** — the design that holds up under standards review, that an engineer can verify by reading code rather than prose, and that an operator can apply without surprises. The bar was set on a prior component (the consent card) through multi-reviewer adversarial review consensus. The author is applying the same rigor here.

---

## 1. Concrete evidence: what the 131 records actually contain

The legacy SQLite database is 5.9 GB at `packages/polyfill-connectors/.pdpp-data/pdpp.sqlite`. It contains roughly 1.2M records across 11 connectors. 131 of those records have `record_json` strings containing U+0000 (the only forbidden Postgres JSONB codepoint we've explicitly verified, though `safeTextPreview` — see §3 — forbids a wider set).

Spot-check of the 131 records:

- Multiple are Codex tool-call records where the user invoked `sed`/`cat`/`xxd` on an ELF binary (`/usr/bin/ls`, etc.) and the connector inlined the raw output bytes into the `output_preview` field of the record's JSON. We traced one example back to its source JSONL at `~/.codex/sessions/2026/03/25/rollout-2026-03-25T16-03-14-…jsonl` and confirmed 3267 occurrences of `\0` from a single ELF binary read.
- Some are Claude Code records with embedded image/file content where the connector inlined the bytes rather than calling the existing blob-storage path.
- Some are chat messages where a previous client embedded image bytes inside a message body that got captured verbatim.

In all 131 cases, the original bytes are valuable (they're real captured content), but the inline-in-JSONB placement is wrong: the same connector run *should* have written the bytes to `blobs` and put a reference in `record_json`. The bug is purely "wrong destination," not "lost data."

We've already shipped a partial fix at the connector layer (codex and claude_code parsers now route binary to a `_binary_reason` companion field and leave the preview slot null), but:

1. The other 9 connectors haven't been audited.
2. The legacy 131 records still exist and block migration.
3. The invariant lives in prose, not in types — a future connector author can re-introduce the same bug.

---

## 2. The connector field taxonomy (what string fields actually mean in PDPP)

Reviewing all 11 connectors' Zod schemas, every string field in `record_json` falls into one of five categories. This taxonomy matters because the proposed invariant must apply *uniformly* across all five, and the migration must preserve the meaning of each.

| Category | Examples | Size cap | Constraint shape |
|---|---|---|---|
| **A. Structured identifiers** | tool name, IDs, ISO dates, currency codes, ASIN, SHA-256 hashes, account IDs | ≤500 chars, often regex-validated | Highly structured, always printable text by definition |
| **B. Bounded display strings** | titles, subjects, names, locations, snippets, descriptions | 200–65 000 chars | Free-form human text but bounded; expected to be printable |
| **C. Large captured payload text** | Slack `text`, ChatGPT `content`, Gmail `body_text`/`body_html`, Reddit `body`/`selftext`, Codex `content`, Claude Code `content` | 1 M – 10 M chars | The **canonical text content of the record** — not a preview |
| **D. Preview-of-something** | Codex `output_preview`, Claude Code `content_preview` | 4 000 chars (`PDPP_PREVIEW_MAX_CHARS`) | A derived, bounded preview of a payload that may be too large or non-text to render in full |
| **E. References to blobs / external** | URLs, file paths, blob sha256s, attachment IDs | varies | Pointers; not content themselves |

Critical observation: **Categories A, B, C, D are all `z.string()` in Zod.** The taxonomy is invisible to the validator. From the schema's perspective, a 4000-char preview field and a 10M-char message body are the same type. They get the same treatment.

This is the structural root cause of the 131-record bug. A connector author who is parsing a CLI tool output, with no enforcement at the schema layer, can drop raw bytes into any string field. Nothing catches it until SQLite→Postgres migration fails six months later.

---

## 3. The existing helper: `safeTextPreview`

A helper already exists at `packages/polyfill-connectors/src/safe-text-preview.ts` (250 lines, 43 unit tests passing). It is the source of truth for "what counts as safe text" in PDPP.

Its return type:

```ts
export const PDPP_PREVIEW_MAX_CHARS = 4000;
export type SafeTextPreviewKind = "text" | "binary" | "empty";
export interface SafeTextPreviewResult {
  kind: SafeTextPreviewKind;
  preview: string | null;       // null when kind != "text"
  truncated: boolean;
  originalLength: number;
  reason: string | null;         // e.g. "U+0000 at offset 342"
}
export function safeTextPreview(value: unknown, maxChars?: number): SafeTextPreviewResult;
```

Its forbidden-codepoint set:

| Range | Status | Rationale |
|---|---|---|
| U+0000 | forbidden | Rejected by Postgres JSONB; identifies binary content |
| U+0001–U+0008 | forbidden | C0 controls; not legitimate text |
| U+0009 (`\t`) | allowed | Common in text |
| U+000A (`\n`) | allowed | Common in text |
| U+000B–U+000C (VT, FF) | forbidden | C0 controls; not legitimate text |
| U+000D (`\r`) | allowed | Common in text |
| U+000E–U+001F | forbidden | C0 controls; not legitimate text |
| U+007F (DEL) | forbidden | Not legitimate text |
| U+0080–U+009F | forbidden | C1 controls; not legitimate text |

Plus a UTF-8 validity check (via `Buffer.isUtf8` with `TextDecoder({fatal:true})` fallback) when input is `Buffer` or `Uint8Array`.

This forbidden set is **broader than Postgres JSONB's**, which rejects only U+0000. The author's position is that the broader set is correct for PDPP: control characters in captured text fields almost always indicate corruption or binary leakage, never legitimate content. We want the invariant to be "PDPP-protocol-safe text," not just "Postgres-JSONB-acceptable bytes."

Two connectors (codex, claude_code) already call `safeTextPreview` proactively in their parsers and route binary content to a `_binary_reason` companion field. The other 9 connectors do not.

---

## 4. The design (as approved)

### 4.1 The invariant

**Every field declared by a connector schema as PDPP text MUST contain only PDPP-safe Unicode text. Binary or control-rich payloads MUST NOT be stored directly in `record_json`; they MUST be stored in `blobs`, with `record_json` containing `null` and the field-to-blob relationship recorded in `blob_bindings` (with a `json_path` column populated, see §4.6).**

"PDPP-safe Unicode text" is **valid Unicode text excluding NUL and non-whitelisted control characters** (whitelist: `\t`, `\n`, `\r`; see §3 for the full forbidden set). It is suitable for JSONB storage, FTS5 indexing, dashboard rendering, and protocol transport without further sanitization.

The invariant attaches to **semantic schema type**, not to Zod's `z.string()` primitive. A field's semantic type — `pdppSafeText`, `pdppIdentifier`, `pdppUrl`, `pdppBlobId`, etc. — declares what content it may carry. The invariant in this brief governs `pdppSafeText` and (transitively) any other text-bearing semantic type. Reference-type fields (Category E from §2) have their own structural constraints and are not in scope here.

A goal of this work is that **after the rollout, there are no semantically anonymous `z.string()` declarations left in connector record schemas.** Every text-bearing field declares its intent.

### 4.2 Why this is the right invariant (and why earlier alternatives were rejected)

The author considered four alternative designs before arriving here. All are rejected; the alternatives are documented so a reviewer can verify the reasoning.

**Alternative 1: "Just allow U+0000 to be silently scrubbed (replace with U+FFFD) at migration time."**
Rejected. Silent corruption with no audit trail. The byte content is permanently lost. Violates "verifiable" in SLVP — a reviewer can't tell which records were altered.

**Alternative 2: "Preserve U+0000-containing strings in JSONB by wrapping them in a base64 envelope `{_pdpp_binary: true, encoding: "base64", data: "..."}`."**
Rejected for the deeper reason that it relocates the violation rather than fixing it. The whole purpose of `blobs` is to be the content-addressed home for binary. An envelope inside JSONB:
- Breaks the dashboard's existing preview-rendering and FTS5 indexing.
- Creates a parallel "binary inside JSONB" pattern that competes with the existing `blobs` pattern.
- Does not deduplicate (the same ELF binary captured 17 times becomes 17 base64 envelopes).
- Forces every downstream consumer to learn a new shape.

**Alternative 3: "Make every captured-content slot a triplet `{preview, payload_ref, payload_reason}`."**
Rejected after closer reading of the connectors. The triplet treats every text field as a derived projection of a payload — but in PDPP most text fields *are* the payload, not a projection of one. Slack's `text`, ChatGPT's `content`, Gmail's `body_text` are not previews; they are the canonical text content of the record. Forcing them into a triplet creates schema noise without benefit.

**Alternative 4: "No enforcement; trust connector authors."**
Rejected. This is what we have, and it produced the 131-record bug. With 11 connectors today and a 30-connector target ecosystem, prose conventions don't scale.

The chosen design (the invariant in 4.1) is the simplest design that:
- Maps onto a structure PDPP already has (`blobs` + `blob_bindings`).
- Can be enforced at the Zod validation gate that every record already passes through.
- Produces no second-class shape (migrated records look identical to clean ingest).
- Treats binary and text as separate concerns with separate homes (which is how content-addressed storage works).

### 4.3 The schema-level enforcement: `pdppSafeText` (a true branded type)

A new branded Zod schema replaces `z.string()` for every text-bearing field in every connector schema:

```ts
// packages/polyfill-connectors/src/pdpp-safe-text.ts (new file)
import { z } from "zod";
import { safeTextPreview } from "./safe-text-preview";

export const pdppSafeText = z
  .string()
  .refine(
    (s) => {
      const result = safeTextPreview(s);
      return result.kind === "text" || result.kind === "empty";
    },
    {
      message:
        "must be PDPP-safe Unicode text (no U+0000, no forbidden control characters, valid UTF-8). " +
        "Binary or control-rich payloads MUST be stored in the blobs table.",
    },
  )
  .brand<"PdppSafeText">();

export type PdppSafeText = z.infer<typeof pdppSafeText>;

export const nullablePdppSafeText = pdppSafeText.nullable();
```

The `.brand<"PdppSafeText">()` call produces a nominally distinct TypeScript type. Functions that accept `PdppSafeText` will not accept a raw `string` without an explicit parse — downstream code can rely on the brand to know that a value has been validated.

The `nullablePdppSafeText` helper exists to make the mechanical rollout less error-prone and to make schema intent visually obvious.

**Mechanical rollout pattern:**

```ts
// Before:
const bodyTextSchema = z.string().max(10_000_000).nullable();
// After:
const bodyTextSchema = pdppSafeText.max(10_000_000).nullable();
// or, equivalently:
const bodyTextSchema = nullablePdppSafeText; // when no max is specified
```

`pdppSafeText` is a strict superset of validation: every string that passes `pdppSafeText` also passes `z.string()`. So existing accepted records continue to validate; new violations fail at the validation gate with a precise error.

### 4.4 The connector classification (broad rollout, semantic typing)

The goal of the connector-side change is not "replace every `z.string()` with `pdppSafeText`." The goal is **classification**: every existing `z.string()` is audited and labeled with its semantic type. Acceptable post-rollout shapes:

```ts
// Allowed in connector record schemas:
pdppSafeText           // human-readable text (titles, bodies, snippets, previews, message content)
pdppIdentifier         // opaque IDs (handled by an additional brand, see below)
pdppUrl                // URL-typed fields (URL validation handled by .url())
pdppBlobId             // sha256-keyed blob reference
z.string().regex(...)  // structurally-constrained fields (dates, currencies, ISO codes, ASIN, etc.)
z.string().url()       // URLs, equivalent to pdppUrl
```

Not all six semantic types must ship on day one. The minimum is `pdppSafeText`. The others may be added incrementally — but a future-proofing principle is established now: **a raw `z.string()` in a connector record schema is suspicious and should be reviewed.** The rollout PR audits every existing `z.string()`, classifying it as one of the above (with explicit comment where the classification isn't obvious).

This produces lasting value beyond the immediate bug fix: the connector schemas become self-documenting about what they carry, and future connector authors have positive types to reach for rather than only negative rules to remember.

### 4.5 The parse-time helper: when and how to call `safeTextPreview`

The Zod brand is the safety net. The intended workflow at parse time is:

```ts
// In a connector parser, capturing tool output that may or may not be text:
const rawOutput: Buffer = readToolOutput();
const result = safeTextPreview(rawOutput, PDPP_PREVIEW_MAX_CHARS);

if (result.kind === "text") {
  record.output_preview = result.preview;       // safe text, possibly truncated
  record.output_binary_reason = null;
} else if (result.kind === "binary") {
  // Route the bytes to the blobs table:
  const blobId = await storage.storeBlob({
    connector_id, stream, record_key,
    mime_type: "application/octet-stream",
    data: rawOutput,
  });
  record.output_preview = null;
  record.output_binary_reason = result.reason;
  record.output_blob_id = blobId;              // or use blob_bindings; both work
} else {
  // empty
  record.output_preview = null;
  record.output_binary_reason = null;
}
```

The pattern is: **`safeTextPreview` is the decision helper at the parse boundary; `pdppSafeText` is the enforcement gate at the validation boundary.** A correct connector uses both. A connector that forgets to call `safeTextPreview` and tries to assign bytes to a text field gets caught by `pdppSafeText` validation. The two layers are complementary, not redundant.

### 4.6 The `blob_bindings` schema change: `json_path` becomes canonical

`blob_bindings` is the join table connecting records to blobs. Its current shape:

```sql
CREATE TABLE blob_bindings (
  blob_id       TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  PRIMARY KEY (blob_id, connector_id, stream, record_key),
  FOREIGN KEY (blob_id) REFERENCES blobs(blob_id)
);
```

This shape can answer "which blobs are bound to this record?" but not "which field in `record_json` does this blob replace?" After migration, a single record may have multiple extracted blobs (e.g., a Codex tool call where both `arguments` and `output_preview` contained binary). Without a per-binding `json_path`, that mapping lives only in the ledger — and **ledgers are operational artifacts; records and bindings are canonical state.** A migration that depends on the ledger to be lossless is not SLVP.

**The new shape:**

```sql
CREATE TABLE blob_bindings (
  blob_id       TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  record_key    TEXT NOT NULL,
  json_path     TEXT NOT NULL,
  PRIMARY KEY (blob_id, connector_id, stream, record_key, json_path),
  FOREIGN KEY (blob_id) REFERENCES blobs(blob_id),
  CHECK (json_path = '@record' OR json_path LIKE '/%')
);
```

**Value conventions:**

- For a blob extracted from a specific `record_json` leaf: use an **RFC 6901 JSON Pointer**.
  - `/output_preview`
  - `/messages/0/content`
  - `/attachments/2/body`
- For a record-level binding with no specific JSON field (e.g., the existing attachment-blob path that links a record to its attachment's bytes without a specific field reference in `record_json`): use the reserved pseudo-path **`@record`**.

The `CHECK` constraint enforces that every value is either `@record` or a JSON Pointer (which always starts with `/`). No `NULL`, no free-form sentinels.

**No `role` column for now.** A `role` column was considered (values like `attachment`, `preview_source`, `extracted_record_json_leaf`) but is deferred. `json_path` carries the necessary provenance; `role` opens taxonomy questions that aren't required to fix the storage invariant. If future queries need role-based filtering, add the column then.

**Migration of the existing schema:**

This is an additive PK change. In Postgres it's a standard `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT '@record'; ALTER TABLE ... DROP CONSTRAINT ...; ALTER TABLE ... ADD PRIMARY KEY ...; ALTER TABLE ... ADD CHECK ...`. In SQLite, PK changes require table rebuild (`CREATE TABLE blob_bindings_new ...; INSERT INTO blob_bindings_new SELECT ..., '@record' FROM blob_bindings; DROP TABLE blob_bindings; ALTER TABLE blob_bindings_new RENAME TO blob_bindings;`). Existing bindings backfill with `json_path = '@record'`, which is consistent with their current semantics (record-level, not field-level, blob references).

**Existing call sites that insert into `blob_bindings`:**

All current `INSERT INTO blob_bindings` call sites correspond to attachment-style bindings (the connector knew the record had an attachment but didn't have a specific JSON field path for it). These continue to insert with `json_path = '@record'`. The migration tool's new extract-to-blobs path uses RFC 6901 JSON Pointers. Search-and-update of insert sites is part of step 3 of the implementation plan in §7.

**Verification of `blobs` deduplication-by-sha256:**

The expert flagged: is "idempotent on sha256" enforced by the database, or only by code convention? Investigation confirms:

- `blob_id` is deterministically computed as `blob_sha256_<hex>` (see `server/queries/blobs/insert-blob.sql` comment: *"the blob_id is `blob_sha256_<hex>`, so a duplicate insert means the exact bytes already exist"*).
- Inserts use `INSERT OR IGNORE` (SQLite) / `ON CONFLICT (blob_id) DO NOTHING` (Postgres-equivalent).
- The PK on `blob_id` therefore *does* enforce sha256-uniqueness, transitively.

So the existing schema satisfies the expert's third option. To make this explicit and resistant to future drift, we add an explicit `UNIQUE` index on `sha256`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uniq_blobs_sha256 ON blobs(sha256);
```

This is redundant with the `blob_id` PK given the current naming convention, but makes the invariant unambiguous in the schema and protects against any future code path that might generate a non-derived `blob_id`.

### 4.6a Migration scope: U+0000 only (narrowed from the full set)

**Late refinement, post-dry-run on real production data.**

The forbidden codepoint set in §3 (U+0000 + C0/C1 controls + DEL) is the right invariant for *new writes*. For *migration*, a dry-run against the 5.9 GB legacy SQLite showed the broader set would treat **4248 leaves** as binary — but only **114** of those are actually U+0000 (the real binary content). The other 4134 are:

- ~780 instances of U+0080 inside mojibake sequences (e.g. `havenâ€™t` — a UTF-8-misencoded curly apostrophe captured by the Gmail snippet pipeline). The bytes are *legible text*, just corrupted upstream.
- ~437 instances of U+001B (ANSI escape sequences) in Codex tool-call output captures.
- ~162 instances of U+0008 (backspace) from terminal-output captures.
- Smaller counts of U+007F, U+0092, U+008F.

Postgres JSONB accepts all of these once they're inside a JS object — only U+0000 actually triggers SQLSTATE 22P05. Extracting a mojibake-laden Gmail snippet to a blob (and setting the snippet field to `null`) destroys far more useful information than it preserves: the user reading the dashboard sees nothing instead of "Hi the owner, Awesome! I will send her a thank you email…".

**Decision:** the migration tool's `migrate-to-blobs` policy extracts only on U+0000. The full printable-text invariant remains enforced for *new* writes via `pdppSafeText` and `safeTextPreview`. Legacy mojibake survives migration as-is, and is left to the connector authors to decide whether to clean up at re-ingest time.

This is a deliberate narrowing of "binary" at the migration boundary, justified by: the cost of extracting a mojibake-laden human-readable string is high; Postgres tolerates the codepoints; the connector-level enforcement still catches new violations.

### 4.7 Migration of the legacy U+0000 records

The migration tool at `reference-implementation/scripts/migrate-storage/` already exists. It transforms SQLite rows into Postgres rows column-by-column, with a JSONB coercion path for the `record_json` column.

The migration behavior for `record_json` string leaves that violate the invariant:

1. Walk the parsed JSON tree, accumulating an RFC 6901 JSON Pointer at each leaf.
2. For each string leaf where `safeTextPreview(leaf).kind === "binary"`:
   - Compute sha256 of the original UTF-8 bytes.
   - `blob_id = "blob_sha256_" + sha256`.
   - Insert into `blobs` (idempotent on sha256/blob_id) with `mime_type = "application/octet-stream"`, `size_bytes = byteLength`, and the row's `connector_id`/`stream`/`record_key`.
   - Insert into `blob_bindings` with the JSON Pointer as `json_path` (e.g., `/output_preview`). Idempotent on `(blob_id, connector_id, stream, record_key, json_path)`.
   - Replace the string leaf with `null` in the parsed JSON.
   - Append one line to the extraction ledger (JSONL): `{timestamp, connector_id, stream, record_key, json_path, sha256, original_byte_length, reason}`.
3. Continue with the (now-clean) parsed JSON as the JSONB value.

**The result: a migrated record is structurally indistinguishable from a record that the fixed connector would produce today.** The field-to-blob relationship is preserved in canonical DB state (`blob_bindings.json_path`), redundantly mirrored in the ledger for audit. The bytes are recoverable from `blobs` via the standard content-addressed mechanism.

**Whole-string extraction (not substring extraction).** When a string leaf contains forbidden codepoints, the entire string is extracted, not just the offending substring. Rationale:
- For Category D previews (codex `output_preview`, claude_code `content_preview`), the preview is derived. If the source is binary, absence of preview is honest.
- For Category C canonical payload text (Slack `text`, Gmail `body_text`, etc.), whole-string extraction is acceptable *because* `blob_bindings.json_path` provides a queryable DB-level path from the field to the recovered bytes. A consumer that sees `text = null` can join `blob_bindings ON json_path = '/text'` to find the extracted content.
- Substring extraction would introduce a new shape (a string with embedded blob references), which violates the "one shape, no special cases" goal of this design.

The CLI surface collapses to two policies:

- `--jsonb-nul-policy strict` (default): refuse to migrate any row containing forbidden codepoints in `record_json`. Useful for users who want to inspect before automating.
- `--jsonb-nul-policy migrate-to-blobs`: apply the extraction described above. Lossless. Produces records identical in shape to clean ingest.

Requirements on `migrate-to-blobs`:

1. **Idempotent by sha256.** Re-running the migration produces no new blobs and no duplicate `blob_bindings` rows (PK on `(blob_id, connector_id, stream, record_key, json_path)` enforces this).
2. **Ledger line per extracted JSON leaf.**
3. **Canonical DB binding includes `json_path`** (RFC 6901 JSON Pointer for field-level extractions, `@record` for record-level).
4. **Original byte length recorded** in both the ledger and `blobs.size_bytes`.
5. **Reason recorded** in the ledger (e.g., `"U+0000 at offset 342"`).
6. **Dry-run mode** (`--dry-run`) that prints exact counts and JSON Pointer paths without mutating state.

(The previous proposal had two more policies — `scrub` and `preserve-base64` — both rejected per §4.2.)

### 4.8 The extraction ledger

The migration writes a sidecar JSONL file (default `./pdpp-data/migration-extractions.jsonl`) with one line per extracted leaf:

```json
{
  "timestamp": "2026-05-11T18:42:13.421Z",
  "connector_id": "codex",
  "stream": "function_calls",
  "record_key": "call_Zo6lUkiLFm6lSBfl7smSwtNo",
  "json_path": "/output_preview",
  "sha256": "f3a1c9b2…",
  "original_byte_length": 4823,
  "reason": "U+0000 at offset 342"
}
```

The ledger's `json_path` value is the same RFC 6901 JSON Pointer stored in `blob_bindings.json_path`. The ledger is **redundant with canonical DB state**, not a substitute for it. After migration, a consumer wanting to find the extracted blob for a specific field has two equivalent paths:

```sql
-- Via canonical DB state:
SELECT b.data FROM blobs b
JOIN blob_bindings bb ON b.blob_id = bb.blob_id
WHERE bb.connector_id = 'codex'
  AND bb.stream = 'function_calls'
  AND bb.record_key = 'call_Zo6lUkiLFm6lSBfl7smSwtNo'
  AND bb.json_path = '/output_preview';
```

```sh
# Via the ledger (audit/replay):
jq 'select(.record_key == "call_Zo6lUkiLFm6lSBfl7smSwtNo" and .json_path == "/output_preview")' \
  migration-extractions.jsonl
```

This ledger is the audit trail. After migration, the operator can:

- Count affected records: `wc -l migration-extractions.jsonl`.
- See per-connector breakdown: `jq '.connector_id' migration-extractions.jsonl | sort | uniq -c`.
- Recover any specific blob: look up sha256, `SELECT data FROM blobs WHERE sha256 = '…'`.
- Decide whether to re-ingest a specific session through the now-fixed connector.

The execute summary printed at end of migration:

```
Migration complete.
  Rows migrated:           1,234,567
  Rows clean:              1,234,436
  Rows with extractions:   131
  Blobs created:           47 (unique sha256s; 8.2 MB total)
  Extraction ledger:       ./pdpp-data/migration-extractions.jsonl
```

### 4.9 The post-migration verifier

SLVP ends with a **checkable assertion**, not just a successful migration. The migration tool adds a `verify` subcommand that walks every `record_json` value in the target Postgres database and asserts:

1. No string leaf anywhere in `record_json` contains forbidden codepoints (NUL, non-whitelisted controls, or invalid UTF-8).
2. For every `blob_bindings` row with a JSON-Pointer `json_path` (i.e., not `@record`), the dereferenced leaf in `record_json` is exactly `null` (the field was correctly cleared during extraction; nothing got missed or restored).
3. For every blob referenced by a binding, the blob exists in `blobs` with the expected sha256.

The verifier:
- Runs automatically as the final step of `execute`, with non-zero exit on failure.
- Is runnable standalone (`migrate-storage verify --to postgres://...`) for re-verification after the fact.
- Prints a summary: `Verified N rows, M blob bindings, K blobs. 0 unsafe strings found.`

A failed verifier is a release-blocker. The point of the verifier is to make the invariant a **provable property of the database**, not just a hope.

### 4.10 What gets deleted from the prior design

Three pieces of work that were already implemented (in a previous round) are removed by this design:

- The `--jsonb-nul-policy scrub` option (replaces U+0000 with U+FFFD). Silent corruption; rejected per §4.2.
- The `--jsonb-nul-policy preserve-base64` option (inlines binary as `{_pdpp_binary: true, …}` envelope inside JSONB). Relocates rather than fixes; rejected per §4.2.
- The `output_binary_reason` / `content_binary_reason` companion fields in codex and claude_code schemas — kept, because they record *why* a preview field is null, which is useful information for the dashboard. But their values are populated by the parser (`safeTextPreview(...).reason`) rather than being a separate concept.

---

## 5. Resolved design questions (formerly open)

The original draft of this brief listed five open questions. The expert review resolved each. Recorded here for traceability.

### 5.1 Whole-string vs substring extraction for canonical payload text (Category C)

**Resolved: whole-string extraction.** Acceptable for all categories *because* `blob_bindings.json_path` (§4.6) provides a queryable canonical DB-level path from the field to the recovered bytes. The "one shape, no special cases" property holds. Substring extraction would introduce an embedded-blob-reference string shape; rejected.

### 5.2 Should `blob_bindings` gain `json_path` now?

**Resolved: yes, now.** Without `json_path` in canonical DB state, the migration's losslessness depends on retaining the sidecar ledger, which makes the ledger temporarily canonical — exactly the "temporary state that becomes permanent" pattern this design exists to fix. The ledger is an audit artifact; canonical state lives in `blob_bindings`. The schema change is documented in §4.6.

### 5.3 Scope: narrow rollout (2 connectors) vs broad (11)

**Resolved: broad.** Narrow rollout is how invariants become folklore. The same canonical `records` table receives writes from all 11 connectors; the invariant must be enforced uniformly. Implementation strategy is **classification, not blind replacement** — every existing `z.string()` is audited and labeled with its semantic type (§4.4).

### 5.4 Is the forbidden codepoint set right?

**Resolved: yes (NUL, C0 except `\t\n\r`, DEL, C1).** Terminal output with ANSI escapes is terminal protocol output, not clean text — if a connector wants the raw form, that belongs in `blobs`; if it wants a clean preview, it strips the escapes first. The wording is updated to "valid Unicode text excluding NUL and non-whitelisted control characters" (not "printable UTF-8") to avoid misleading implications about emojis, combining marks, or RTL controls — all of which are valid PDPP-safe text.

### 5.5 Downstream consumer audit (expanded list)

**Resolved: audit before declaring done. The list expanded:**

The original five (dashboard, FTS5, `primary_key_text`, streaming/sync, disclosure-spine, consent-card preview generation) plus:

- Any API endpoint that serializes records directly to clients.
- Any sync/export endpoint that assumes `record_json` contains the full canonical payload.
- Any search indexer beyond FTS5 (now or planned).
- Any cursor/diff logic that compares JSON payloads.
- Any code that treats `null` as "source did not provide this field" rather than "field existed but was extracted."
- Any schema-derived UI that assumes `z.string().nullable()` means "ordinary optional text."
- Any test snapshots that may silently normalize or omit nulls.
- Any analytics/counting pipeline that measures text length or content presence.

**The subtle semantic trap:** after migration, `null` may mean three things — (1) field genuinely absent, (2) field empty, (3) field extracted to blob. Where this distinction matters, the disambiguator is a `blob_bindings` join on `json_path`. This is part of why `json_path` belongs in canonical DB state.

The audit is a deliverable of the implementation plan (§7, step 7).

---

## 6. Verdict (incorporating expert review)

**Approved with amendments.** The core architecture is correct: binary belongs in `blobs`; JSONB carries only PDPP-safe text; validation enforces this uniformly; migration is lossless and auditable.

The amendments (incorporated above):

1. Invariant restated in terms of **semantic schema type**, not Zod primitive.
2. `pdppSafeText` is a **real branded type** via `.brand<>()`.
3. The connector-side rollout is **broad and is classification**, not blind replacement.
4. `blob_bindings` gains **`json_path TEXT NOT NULL`** with `CHECK (json_path = '@record' OR json_path LIKE '/%')`, before the migration runs.
5. Extracted leaves use **RFC 6901 JSON Pointer** values; record-level bindings use the reserved pseudo-path **`@record`**.
6. Migration policies collapse to **`strict`** and **`migrate-to-blobs`**. No `scrub`. No `preserve-base64`.
7. **No `role` column** on `blob_bindings` for now.
8. The ledger is **redundant audit**, not canonical state.
9. A **post-migration verifier** subcommand asserts the invariant holds in the target DB; non-zero exit on failure; part of `execute` by default.
10. An explicit **`UNIQUE INDEX` on `blobs.sha256`** is added to make sha256-uniqueness an unambiguous DB constraint rather than a derived consequence of `blob_id` naming.

---

## 7. Implementation plan (the implementation contract)

Structured as staged commits. The release is atomic, but the engineering work is reviewable in pieces.

### Stage 1 — Design contract

This document. Lands first.

### Stage 2 — `blob_bindings` schema migration

- `reference-implementation/server/db.js`: rewrite `blob_bindings` CREATE statement; rebuild table at startup if old shape is detected (SQLite table-rebuild migration script).
- `reference-implementation/server/postgres-storage.js`: same for Postgres (`ALTER TABLE` sequence).
- Backfill all existing rows with `json_path = '@record'`.
- Add `UNIQUE INDEX uniq_blobs_sha256 ON blobs(sha256)` (both backends).
- Tests: schema migration is idempotent; existing rows survive with `@record`; `CHECK` constraint rejects bad values.

### Stage 3 — Call-site updates for blob binding insertion

- Search every existing `INSERT INTO blob_bindings` (and any ORM-equivalent paths) in `reference-implementation/server/`.
- Update to pass `json_path = '@record'` for current attachment-style bindings.
- Tests: existing connector tests still green; explicit unit test that a fresh attachment binding gets `json_path = '@record'`.

### Stage 4 — `pdppSafeText` brand and connector string classification

- New: `packages/polyfill-connectors/src/pdpp-safe-text.ts` with `pdppSafeText`, `PdppSafeText` type, `nullablePdppSafeText` helper, and tests.
- Audit every `z.string()` in every connector schema in `packages/polyfill-connectors/connectors/*/schemas.ts`. Classify and replace:
  - Human-readable text (titles, bodies, snippets, previews, message content) → `pdppSafeText`.
  - Already-regex-validated structural strings → leave as `z.string().regex(...)`.
  - URLs → keep as-is or move to `z.string().url()`.
  - Add comments where the classification isn't obvious.
- The goal: **after this stage, no semantically anonymous `z.string()` remains in any connector record schema.**
- Tests: existing connector test suites still pass; new test asserting that a record with U+0000 in any classified-text field is rejected by validation.

### Stage 5 — Migration tool update

- `reference-implementation/scripts/migrate-storage/transformers.mjs`:
  - Drop `scrub` and `preserve-base64` from policy enum.
  - Implement `migrate-to-blobs`: walks parsed JSON, computes RFC 6901 pointer per leaf, extracts binary leaves to `blobs` + `blob_bindings`, clears leaf.
  - Idempotent on `(blob_id, json_path)` PK.
- `reference-implementation/scripts/migrate-storage/cli.mjs`:
  - Update `--jsonb-nul-policy` enum to `strict` / `migrate-to-blobs` only.
  - Add `--dry-run` flag.
  - Add `--ledger <path>` flag (default: `./pdpp-data/migration-extractions.jsonl`).
  - Update execute summary format (per §4.8).
- Tests: strict refusal with descriptive error including JSON Pointer; migrate-to-blobs extracts a U+0000 leaf to `blobs` with correct sha256/size/binding/json_path; ledger line shape; idempotent re-run; deduplication when the same bytes appear in two records.

### Stage 6 — Verifier

- New `verify` subcommand on `migrate-storage` CLI.
- Walks every `record_json` row, asserts no string leaf contains forbidden codepoints.
- Cross-checks `blob_bindings` rows with JSON-Pointer `json_path` against `record_json` leaves (the leaf must be `null`).
- Cross-checks every `blob_bindings.blob_id` exists in `blobs` with expected sha256.
- Runs automatically at end of `execute`; standalone via `verify`.
- Tests: verifier passes on a clean DB; fails (non-zero exit, useful message) when given a DB with a U+0000 string seeded for the test.

### Stage 7 — Downstream consumer audit and docs

- Walk the audit list from §5.5. Verify each consumer behaves correctly with `null` field values and with `blob_bindings`-via-`json_path` lookup.
- Update docs:
  - `packages/polyfill-connectors/docs/connector-authoring-guide.md`: invariant section, `pdppSafeText` usage, parse-time `safeTextPreview` + blob-routing code example, table of acceptable semantic types.
  - `reference-implementation/docs/migrate-storage.md`: rewrite the U+0000 / binary leaks section to describe the two-policy model, the `json_path` semantics, the ledger format, and the verifier.

### Stage 8 — Run the migration

- Execute `migrate-storage execute --from <sqlite> --to <postgres> --jsonb-nul-policy migrate-to-blobs --ledger ./pdpp-data/migration-extractions.jsonl`.
- Verify the extraction ledger shows ~131 entries (matches the spot-check from §1).
- The verifier runs automatically as part of `execute` and gates success.
- Cross-check: count `blob_bindings` rows with JSON-Pointer `json_path`; should equal ledger line count.
- Sanity-check the migrated DB: count rows per table, verify a sample of extracted blobs can be retrieved by sha256, verify FTS5 reindexing works, verify the dashboard renders the previously-broken records without errors.

---

## 8. Out of scope

Items explicitly excluded from this design:

- The choice to use Postgres as the migration target.
- The choice of Zod as the validation library.
- The architecture of `blobs` + `blob_bindings` (the architecture is unchanged; this design only adds `json_path` to `blob_bindings` and a `UNIQUE` index on `blobs.sha256`).
- The protocol-level question of whether PDPP should track binary content at all.
- The 11-connector list.
- A `role` column on `blob_bindings` (deferred until a query needs it).
- Substring extraction (rejected; see §4.7).
- The `scrub` and `preserve-base64` migration policies (rejected; see §4.2 and §4.10).

---

## 9. Change log from the original brief

The original brief (§1–§4 below) was structured as a review request with five open questions in §5. This revision incorporates the expert's amendments as the implementation contract. Differences from the original:

| Original | Revised |
|---|---|
| Invariant scoped to "every string-typed field" | Invariant scoped to **fields declared as PDPP text by their semantic schema type** (§4.1) |
| `pdppSafeText` described as a "Zod brand" but not actually branded | `pdppSafeText` is a **true branded type** via `.brand<"PdppSafeText">()`; `nullablePdppSafeText` helper added (§4.3) |
| Connector rollout: "migrate `z.string()` → `pdppSafeText` for text-typed fields" | Connector rollout: **classification, not replacement** — every `z.string()` is audited and labeled (§4.4) |
| `blob_bindings` change deferred (open question §5.2) | `blob_bindings.json_path TEXT NOT NULL` added now; **RFC 6901 JSON Pointer** for field-level extractions; **`@record`** pseudo-path for record-level (§4.6) |
| Extraction ledger as primary mapping for migrated records | Ledger is **redundant audit**, not canonical state. Canonical state lives in `blob_bindings.json_path` (§4.8) |
| Three migration policies (strict, scrub, preserve-base64) | **Two policies** (strict, migrate-to-blobs). `scrub` and `preserve-base64` deleted |
| No post-migration verification | **Verifier subcommand** mandatory; runs at end of `execute`; non-zero exit on invariant violation (§4.9) |
| `blobs.sha256` uniqueness implicit (derived from `blob_id` naming convention) | Explicit **`UNIQUE INDEX uniq_blobs_sha256 ON blobs(sha256)`** added (§4.6) |
| Forbidden-codepoint wording: "printable UTF-8" | "Valid Unicode text excluding NUL and non-whitelisted control characters" (§4.1) |
| Single-PR implementation | **Staged commits within one coordinated release** (§7) |
| 5 open questions for review | **All resolved**; recorded in §5 for traceability |

---

## Appendix A: file-tree references for the reviewer

If reading the code:

- `packages/polyfill-connectors/src/safe-text-preview.ts` — the helper and its forbidden-codepoint set.
- `packages/polyfill-connectors/src/safe-text-preview.test.ts` — 43 tests on the helper.
- `packages/polyfill-connectors/connectors/*/schemas.ts` — the 11 connector Zod schemas; survey the `z.string()` usages.
- `packages/polyfill-connectors/connectors/codex/parsers.ts` — example of `safeTextPreview` already in use.
- `packages/polyfill-connectors/connectors/claude_code/parsers.ts` — same.
- `reference-implementation/server/db.js` — SQLite schema; see `records`, `blobs`, `blob_bindings` tables.
- `reference-implementation/server/postgres-storage.js` — Postgres DDL for the same tables.
- `reference-implementation/server/postgres-records.js:202` — `primary_key_text` derivation, the place most affected by NULL preview fields.
- `reference-implementation/scripts/migrate-storage/` — the migration tool: `cli.mjs`, `transformers.mjs`, `schema.mjs`.
- `reference-implementation/scripts/migrate-storage/transformers.mjs` — the current `coerceJsonb` implementation with three policies; this design replaces it with a two-policy version that writes to `blob_bindings.json_path`.
- `reference-implementation/server/queries/blobs/insert-blob.sql` — comment confirms `blob_id = "blob_sha256_<hex>"` deterministic naming (relevant to §4.6 dedup discussion).
- `reference-implementation/docs/migrate-storage.md` — existing migration documentation; rewritten in stage 7.

## Appendix B: glossary

- **PDPP** — Personal Data Polyfill Protocol.
- **Connector** — TypeScript module adapting a data source into PDPP records.
- **Stream** — a typed sequence of records emitted by a connector (e.g., `messages`, `attachments`).
- **Record** — a single row in the `records` table; JSON payload validated by the connector's Zod schema.
- **Blob** — binary content stored content-addressed by sha256 in the `blobs` table.
- **Blob binding** — a row in `blob_bindings` linking a blob to a (connector_id, stream, record_key, json_path) tuple. After this design, every binding records a JSON Pointer or `@record`.
- **`json_path`** — the new `blob_bindings` column. Either an RFC 6901 JSON Pointer (e.g., `/output_preview`) for field-level bindings, or the reserved pseudo-path `@record` for record-level bindings.
- **`@record`** — reserved `json_path` pseudo-value for bindings that aren't tied to a specific `record_json` field (e.g., attachment-style record-level bindings).
- **SLVP** — the owner's quality bar: "Simplest Lossless Verifiable Path." A design that is the simplest possible, preserves all information losslessly, and is verifiable by reading code or schema (not prose).
- **JSONB** — Postgres binary JSON type. Forbids U+0000 in string values (SQLSTATE 22P05).
- **`record_json`** — the JSON column on the `records` table.
- **`pdppSafeText`** — the branded Zod schema (`z.string().refine(...).brand<"PdppSafeText">()`) replacing `z.string()` for text fields. Defined in `packages/polyfill-connectors/src/pdpp-safe-text.ts`.
- **`PdppSafeText`** — the TypeScript type produced by the brand. Carries the validation guarantee through downstream code.
- **`safeTextPreview`** — the existing parse-time helper that decides whether a value is safe text. Used by parsers to choose between text-field and blob-routing paths.
- **Extraction ledger** — the JSONL audit file produced by the migration. **Redundant with canonical DB state** (`blob_bindings.json_path`); useful for audit/replay but not authoritative.
- **RFC 6901** — JSON Pointer specification. The format used for `blob_bindings.json_path` values (`/foo`, `/messages/0/content`).
- **Verifier** — the `migrate-storage verify` subcommand that asserts the post-migration invariant holds. Non-zero exit on failure. Mandatory part of `execute`.
