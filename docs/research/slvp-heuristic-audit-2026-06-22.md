# SLVP Heuristic Audit — Explore / Record-Presentation

**Audit date:** 2026-06-22
**Auditor:** Claude (read-only, no code changes)
**Scope:** Explore / record-presentation / read-surface code in `the local deploy worktree`

---

## Already-Documented Finding (confirm only)

`classifyRecordKind` — `classifyByStreamName` / `classifyByStrongField` / `classifyByWeakField` / `refineByBody` family **EXISTS** at:

- `packages/operator-ui/src/lib/record-kind.ts` L52–L291 (regex definitions + classifiers), L317–L382 (dispatch)

Already documented in `docs/research/record-kind-declared-not-guessed-plan-2026-06-22.md`. Not re-investigated here.

---

## Findings Table (P0 → P1 → P2)

| # | File:Line | What's Guessed | From What | Declared Alternative | Blast Radius | Sev | Fix |
|---|-----------|---------------|-----------|----------------------|--------------|-----|-----|
| 1 | `packages/operator-ui/src/lib/record-preview.ts:L128` | Amount **UNIT** (milliunits vs. dollars) — divides raw value by 1000 when `abs(v) > 10_000` | Value **magnitude** (numeric threshold) | `x_pdpp_type: currency_milliunits` → `formatDeclaredAmount` (already checked first but only fires when manifest declared) | **CONTENT** — a value like 12,001 (legitimate whole-dollar payroll) becomes "$12.00" instead of "$12,001.00" for any stream whose manifest did not declare `currency_milliunits`. Wrong number shown to user. | **P0** | Remove the magnitude branch entirely. If `formatDeclaredAmount` returns null (no declared type), call `formatDollars(v)` without division as the honest fallback. The declared type is the only gate for ÷100 or ÷1000. |
| 2 | `packages/operator-ui/src/explore/timeline-summaries.ts:L173–L178` (`formatAmount`) | Same amount **UNIT** heuristic — `abs > 10_000 → ÷1000` in feed-row summary path | Value **magnitude** | `x_pdpp_type` on the `amount` field (consumed by Explorer card, **not yet plumbed** to `summarize()`) | **CONTENT** — the feed-row summary for every transaction record silently reinterprets raw integers. **Worse than #1**: this path has NO declared-type override; it unconditionally uses the magnitude heuristic for any `data.amount`. | **P0** | Remove the magnitude branch. Treat undeclared `amount` as dollars (no division). Ideally, plumb `DeclaredFieldTypes` into `summarize()` and call `formatDeclaredAmount`. |
| 3 | `packages/operator-ui/src/explore/timeline-summaries.ts:L181–L188` (`summarizeMessageLike`), `L211–L225` (`summarizeTransactionLike`), `L226–L235` (`COMMON_TITLE_FIELDS`), `L280–L291` (generic fallback) | One-line summary **CONTENT** — selects which field values to render as the human-readable summary by guessing which fields mean "author", "body", "title", "merchant", etc. | Field **NAMES** (`author_role`, `role`, `content`, `text`, `message`, `body`, `amount`, `merchant`, `description`, `title`, `name`, `subject`, ...) | `x_pdpp_role` on manifest fields; `DeclaredFieldRoles` already plumbed into Explorer card builders — **not yet plumbed into `summarize()`** | **CONTENT** — the one-line feed row summary is entirely field-name-driven. For known connectors it is hand-curated; for all other streams the `summarizeFallback()` chain guesses: stream-name → `COMMON_TITLE_FIELDS` name probe → `firstString()` (first non-ID string in JS object-key order). A field named `body` on a financial record becomes the headline. | **P0** | Plumb `DeclaredFieldRoles` into `summarize()`; use the `primary-title` role field first, `secondary` second, fall to `firstString` only for completely undeclared records. Flag the hand-curated `SUMMARIES` table as tech-debt to migrate to manifest role declarations. |
| 4 | `packages/operator-ui/src/explore/timeline-summaries.ts:L34–L48` (`firstString`) | One-line summary **primary content** — returns the first non-UUID, non-ID-named string field in JS object-key order | Field **order** in the record object (serialization insertion order) + UUID regex on **values** | `x_pdpp_role: primary-title` | **CONTENT** — for any undeclared stream, whatever string field happens to be first in the JSON becomes the summary headline. Pure insertion-order luck; the UI presents it as a meaningful summary. | **P0** | `DeclaredFieldRoles.primary-title` must be the first lookup; `firstString` stays as a last-last resort. |
| 5 | `apps/console/src/app/dashboard/explore/explore-canvas.tsx:L253,L270–L273` (`entryHasLink` / `URL_LINK_RE`) | Whether a record "has a link" — surfaces `has:link` filter and `QuerySuggestion` | Value-shape **regex** `^https?:\/\//i` run against `preview.body`, `preview.title`, `entry.summary` | A declared `link`-typed field capability (does not yet exist in the protocol); `has:image` correctly uses `blobAffordance` (declared) as the counterpart | **COSMETIC + FILTER** — `has:link` produces results only if the preview fields happen to contain a URL string; misses records where the URL is in a non-preview field; false-positives if any body/title starts with `https://` for non-link reasons. The code itself admits this is a last-resort fallback. | **P1** | Add a `link` affordance to the server's `field_capabilities` vocabulary (analogous to `blob`); `entryHasLink` checks that declared affordance first. Until then, the URL regex on preview text is the honest best-effort — the code correctly marks it as "server-inexpressible." |
| 6 | `packages/operator-ui/src/lib/record-kind.ts:L52–L86` (stream-name regexes), `L219–L291` (field-name regexes) | Record **GLYPH / KIND TAG** (message / money / event / activity / reader / location / titled) | Stream **NAME** + field **NAMES** + field value **LENGTH** (>280 chars → "reader") | `x_pdpp_type` on `field_capabilities[]` (already consumed as the preferred path; these heuristics fire only when no types declared) | **COSMETIC** — glyph/tag is presentation-only, never written back. Declared-type path wins when the manifest declares types. Already in the existing plan doc. | **P1** | Already documented. SLVP-ideal: every manifest declares types via `x_pdpp_type`; the heuristic path disappears. |
| 7 | `packages/operator-ui/src/explore/timeline-summaries.ts:L59–L168` (`SUMMARIES` connector-specific table) | One-line summary **CONTENT** for known connectors — hard-codes which fields to read by name for chatgpt, claude-code, codex, gmail, chase, ynab, usaa, oura, github, etc. | CONNECTOR ID + field **NAMES** hardcoded in client code | Manifest `x_pdpp_role` declarations on those fields | **CONTENT** — accurate today for the specific connectors listed (hand-verified), but diverges silently when a connector renames a field or adds a new stream. No schema contract; client-maintained parallel to the manifest. | **P1** | Treat the `SUMMARIES` table as temporary tech-debt. Each entry should migrate to manifest `x_pdpp_role` declarations and the generic `summarize()` path that reads declared roles. |
| 8 | `packages/operator-ui/src/lib/record-kind.ts:L307–L315` (`manifestFieldNames` fallback for search hits) | Kind **TAG** for search hits (body absent) — derives kind from manifest field NAMES as a proxy for the record body | Manifest field **NAMES** (from `schema.properties` keys) treated as if they were body keys | `x_pdpp_type` on those same fields (already preferred when present; manifest field names only consulted when `data` is null and no types declared) | **COSMETIC** — search hits get a kind tag inferred from manifest field names. A manifest field named `amount` → "money" tag. Less risky than body-level guessing (manifest fields are stable), but still NAME-based. Declared `x_pdpp_type` already wins when present. | **P2** | When all manifests carry `x_pdpp_type`, remove the `manifestFieldNames` fallback from `classifyRecordKind`. Until then, acceptable: only fires when no declared types exist. |
| 9 | `packages/operator-ui/src/lib/record-preview.ts:L175–L185` (`genericValue`) | Whether to **SHOW** an empty array/object in the generic key/value table | Value **shape** (is it an empty array or empty object?) | N/A — this is de-noising of genuinely empty data, not a meaning-from-name inference | **COSMETIC** — filtering `[]`/`{}` from the generic key/value card. This is a value-shape observation about display readability, not a semantic claim about meaning. | **P2** | None needed. Empty-collection de-noising is a value-shape observation, not a semantic claim. |

---

## Severity Summary

| Severity | Count | Description |
|----------|-------|-------------|
| **P0** | 4 | Amount unit guessed from magnitude in Explorer card (#1) and feed-row summary (#2); summary content field-name guessed via `SUMMARIES` table + generic fallback (#3); `firstString` insertion-order fallback (#4) |
| **P1** | 3 | `has:link` URL regex (#5); classifyRecordKind stream/field-name kind tag (#6, already in plan doc); hard-coded `SUMMARIES` connector table (#7) |
| **P2** | 2 | Manifest field-name kind tag for no-body search hits (#8); empty-collection de-noising (#9) |

---

## Worst Finding

**Finding #2** (`timeline-summaries.ts` `formatAmount`): the magnitude heuristic for the feed-row summary has **no declared-type escape hatch at all**. It unconditionally divides any `data.amount` > 10,000 by 1000. Finding #1 (Explorer card) at least checks `formatDeclaredAmount` first. Both are P0 but #2 is worse because there is no correct path — every dollar amount above $10,000 on an undeclared stream is shown as 1/1000th its value.

---

## CLEARED — Checked, Not a Heuristic

- **`has:image` / `entryHasImage`** (`explore-canvas.tsx`): uses `entry.blobAffordance?.state === "available"` — server-declared signal. Correct.
- **`humanizeFieldLabel`** (`field-label.ts:L34–L59`): transforms `net_pay` → "Net pay" via camelCase/underscore splitting. Display transform of the raw key itself; not a meaning-from-name inference. Correct.
- **`formatDeclaredAmount`** (`packages/pdpp-brand/record-format.ts`): only triggers on manifest-declared `currency` / `currency_minor_units` / `currency_milliunits` via `x_pdpp_type`. No magnitude heuristic here. Correct.
- **`declaredRolesFromCapabilities`** in `explore-data-assembler.ts`: reads `field_capabilities[].role` (manifest-declared). Correct.
- **`declared-field-roles.ts` entirely**: consumption-only from manifest declarations. No heuristics. Correct.
- **`set-descriptor.ts`**: describes query completeness and pagination shape — no record-content inference. Correct.
- **`explore-grammar.ts`**: query parsing. `has:image` routes to `blobAffordance` (declared). `has:link` routes to `entryHasLink` (URL regex — flagged as Finding #5; code marks it as a last-resort). Correct handling noted.
- **`search-hit-attribution.ts`**: routes hits to connections by `connection_id` or single-match `connector_id` deduction. Connection-identity logic, not content inference. Correct.
- **`explore-feed-grouping.ts`**: groups by date, detects burst patterns by partition+stream+time proximity. No field-name or value-meaning inference. Correct.
- **`explore-data-assembler.ts` `connectorSummaryDisplayName`**: uses `display_name` (server-provided) then `connector_display_name` (server-provided), then `formatConnectorNameForDisplay` which converts the registry URI to a short key. Registry-key display transform, not a meaning-from-field-name guess. Correct.
- **`classifyByDeclaredTypes` in `record-kind.ts`**: reads declared `x_pdpp_type` values. Correct first-tier path.
- **`record-preview.ts` typed card builders** (`buildMoneyPreview`, `buildMessagePreview`, etc.): all slot-filling via `roleValue(data, roles, "primary-title")` etc. — reads declared roles only. Field-name heuristic lists (`TITLE_FIELDS`, `BODY_FIELDS`) were REMOVED per Codex end-review. Correct.
- **`rowPrimary` in `record-preview.ts`**: falls to declared roles → first generic field → neutral record-id fallback. No field-name guess for content promotion. Correct.
- **`genericValue` empty-collection filter**: value-shape de-noising of `[]`/`{}`. Categorized P2/cleared above.

---

## Key Notes for Follow-up

The **magnitude heuristic appears in two separate places** (Findings #1 and #2) with the same code pattern (`Math.abs(v) > 10_000 ? v / 1000 : v`). Both need to be removed together. The Explorer card (#1) is partially mitigated by `formatDeclaredAmount` being checked first; the summary path (#2) has no mitigation.

The **`summarize()` path** (Findings #3, #4) is the largest surface — it runs for every feed row in every view. The hand-curated `SUMMARIES` table is accurate for known connectors today but is a client-side parallel to what should be manifest declarations. The `firstString` fallback is especially vulnerable to insertion-order luck for undeclared streams.

**Finding #5 (`has:link`)** is the only client-side post-filter lacking a declared server counterpart. The code is honest about the limitation — comments explicitly note "last-resort fallback, never used for image/blob detection" — but it remains a value-regex heuristic users can invoke via `has:link` in the query bar.
