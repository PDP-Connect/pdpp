# User-Facing Copy Audit — 2026-06-11

Scope: `apps/console/src`, `packages/operator-ui/src`, supporting libs.  
Method: grep + direct file reads with verified line numbers.  
Files audited: ~40 source files. Test files, code comments, and internal log strings excluded.

---

## 1. Canonical Vocabulary Glossary

Each term includes: the agreed definition, the approved user-facing label, and the
internal state value it maps to (where applicable).

| Term | Definition | Approved user-facing copy |
|------|-----------|--------------------------|
| **Source** | A provider type you can collect from (e.g. "ChatGPT", "USAA"). Not an instance; not a connection. | "Source" (catalog entries, section headers) |
| **Connection** | One authorized link to a source, tied to one account at that provider. The entity that has health state, runs, and records. Multiple connections per source type are supported (second account). | "Connection" (detail pages, count labels) |
| **Account** | The identity at the provider that a connection authenticates as. Implicit to the connection; not a first-class UI object today. | "account" (lowercase, in phrases like "Add another account") |
| **Collector** | The engine (connector code or polyfill) that runs a connection. Internal term. The two kinds are: *remote* (scheduler-triggered) and *local-collector* (push from owner's device). | Not shown directly to the user. Referred to as "local collector" only in device-push contexts. |
| **Run** | One execution of a collector for a connection. Has a status (succeeded, failed, etc.) and produces records. | "run" / "runs" |
| **Sync** | Owner-triggerable action that starts a remote run immediately. | "Sync now" (button), "Syncing…" (in-progress label) |
| **Collection** | The ongoing process of a run gathering records from a source. | "collection" (lowercase, in guidance text) |
| **Stream** | A named channel of records within a connector (e.g. "transactions", "statements"). | "stream" (lowercase) |
| **Record** | One item of data collected from a source (e.g. one bank transaction). | "record" / "records" |
| **Coverage** | Whether all required streams have collected the data they are supposed to. Displayed as an axis chip. | "Coverage · {state}" — see chip vocab below |
| **Gap** | A range of records a run was supposed to collect but did not. May be retryable or terminal. | Surfaced as "pending gaps" count on stream detail, or in coverage chips. |
| **Pending** | Work the scheduler expects an ordinary future run to pick up. Not an error; records already collected stay valid. | "pending gaps" (count chip on stream), "resumes collection" (forward disposition label) |
| **Deferred** | Coverage the manifest intentionally does not require yet; not a failure. | "Coverage · deferred" |
| **Reconnect** | Re-authorizing an EXISTING connection whose credentials died. Routes to the add-source setup flow as a fresh start. IMPORTANT: does NOT create a new connection; the new setup replaces the credential path only. | "Reconnect" (on `blocked` credential-failure connections ONLY) |
| **Add connection / Add source** | Create a NEW connection to a source (either a brand-new source type, or a second account on an existing source). | "Add source" (page-level header button, section CTA), "Add another account" (per-source card when self-service is available) |

### Health-State Pill Vocabulary

These are the approved labels produced by `deriveConnectionStatusDisplay()` in `connection-evidence.ts`.

| State value | Pill label | Shape | Tone | Plain-language meaning |
|-------------|-----------|-------|------|------------------------|
| `healthy` + durable progress | **Healthy** | circle | success (green) | Required coverage is current and complete. |
| `healthy` + no durable progress | **Ready** | circle | neutral | Readiness checks pass; no records collected yet. |
| `needs_attention` | **Needs attention** | diamond | warning | Owner action required before the next run can make progress. |
| `cooling_off` (failure back-off) | **Cooling off** | diamond | warning | In scheduler back-off after recent failures; will retry automatically. |
| `cooling_off` (source pressure) | **Cooling off** | diamond | warning | Source is throttling the connection; captured progress retained, resumes automatically. |
| `blocked` (genuine, non-source-pressure) | **Blocked** | triangle | danger | Connection cannot make progress — usually expired credentials or a blocked session. |
| `degraded` + `retryable_gap` coverage | **Resuming** | diamond | warning | Outstanding recoverable detail; an ordinary run will fill it. |
| `degraded` + `gaps`/`partial` coverage | **Partial** | diamond | warning | Only partial data collected; coverage or freshness incomplete. |
| `degraded` (other) | **Degraded** | diamond | warning | Useful data may exist but coverage or freshness is incomplete. |
| `idle` + local-collector active outbox | **Syncing** | — | running | Local-device outbox is draining. |
| `idle` + durable progress | **Ready** | — | neutral | Records exist; no active issue known. |
| `idle` + no durable progress | **Awaiting first sync** | — | neutral | No records yet; trigger a sync. |
| `unknown` | **Unknown** | — | neutral | Projection evidence is incomplete. |

### Coverage Axis Chip Vocabulary

Chips render as "Coverage · {value}" from `COVERAGE_LABELS` in `connection-evidence.ts`.

| Internal axis | Chip value | Plain-language meaning |
|--------------|-----------|------------------------|
| `complete` | complete | All required streams have durable evidence of complete coverage. |
| `deferred` | deferred | Manifest intentionally defers; nothing owed yet. |
| `partial` | partial | Some required streams collected only partial data. |
| `gaps` | gaps | Required coverage has known retryable or terminal gaps. |
| `inventory_only` | inventory only | Only discovery/inventory evidence required for this source. |
| `retryable_gap` | retryable gap | Missing detail the runtime expects to fill on a later run. |
| `terminal_gap` | won't backfill | Detail that won't backfill without a connector/source change. Records already collected stay valid. |
| `unavailable` | unavailable | Manifest accepts this coverage is unavailable from the source. |
| `unknown` | unknown | No durable coverage evidence available yet. |
| `unsupported` | unsupported | Source does not support this coverage type. |

### Forward-Disposition (Next-Action Pill) Vocabulary

| Disposition value | Label | Meaning |
|------------------|-------|---------|
| `complete` | nothing owed | Coverage established and fresh. |
| `resumable` | resumes collection | Outstanding work an ordinary run will pick up. |
| `awaiting_owner` | blocked on you | Coverage gap blocked on owner action (re-auth, prompt). |
| `owner_refresh_due` | refresh due | Data stale; connection only refreshes when owner runs it. |
| `terminal` | won't backfill | Gap that won't fill without a change. |
| *(unrecognized)* | unknown | Console does not recognize the value reported by the reference. |

### Source Add-Support Chip Vocabulary (`source-add-support.ts`)

| Support type | Chip label |
|-------------|-----------|
| `self_service` | Add another account |
| `packaged_path_pending` | Packaged path pending |
| `deployment_prerequisite` | Adding another account needs deployment setup |
| `not_self_service` | Existing data only |

---

## 2. Defect Table

Total defects found: **19**

Format: `file:line | current text | why it's wrong | proposed replacement`

---

### D-01 — "Sources (N)" counts connections, not source types

**File:** `apps/console/src/app/dashboard/components/views/records-list-view.tsx:352`  
**Current text:** `` `Sources (${primaryConnections.length})` ``  
**Why wrong:** `primaryConnections` is an array of `ConnectorOverview` — one entry *per connection*, not per source type. With 19 connections across 8 sources this renders "Sources (19)" when there are really 19 connections. The section header noun must match what is being counted.  
**Proposed:** `` `Connections (${primaryConnections.length})` ``

---

### D-02 — "Add source" header button should be "Add connection"

**File:** `apps/console/src/app/dashboard/components/views/records-list-view.tsx:412`  
**Current text:** `Add source`  
**Why wrong:** This button opens the setup flow to create a *new connection* (or add a second account on an existing source). The canonical vocabulary reserves "Add source" for discovering a brand-new source type; the action taken here creates a *connection*. The `data-testid` already reads `add-connection-action`, exposing the intent mismatch.  
**Proposed:** `Add connection`

---

### D-03 — "Add source →" fallback link on per-source card should be "Add connection →"

**File:** `apps/console/src/app/dashboard/components/views/records-list-view.tsx:590`  
**Current text:** `Add source →`  
**Why wrong:** This link appears on a source card in the SourceAccountsSummary section when add-another-account is not self-service. It routes to the same setup picker as the header button. For a source the user *already has*, the action is adding another *connection* (or account), not adding a new source type. "Add source" implies starting from scratch.  
**Proposed:** `Add connection →`

---

### D-04 — "Reconnect" shown for a revoked connection on the list-view source card navigates to add-source setup, not re-auth

**File:** `apps/console/src/app/dashboard/components/views/records-list-view.tsx:559`  
**Current text:** `Reconnect`  
**Why wrong:** This button fires when `group.attentionRouteId` is set (i.e. a connection in `needs_attention` or `blocked` state). It navigates to `/dashboard/records/${attentionRouteId}` — the *connection detail page*, which is correct for credential-dead connections. However the label "Reconnect" implies immediate credential repair, not navigation to a detail page. For a connection that is `blocked` due to source pressure (rate-limiting), "Reconnect" is doubly misleading — no credential has died.  
**Proposed:** `Fix connection` (or `Review connection` if no immediate action is possible)

---

### D-05 — "Reconnect" on revoked connection in detail-page header goes to add-source picker, mislabeled

**File:** `apps/console/src/app/dashboard/records/[connector]/page.tsx:365`  
**Current text:** `Reconnect` (button when `revoked === true`)  
**Why wrong:** The href is `addSourceHrefForConnector(connectorId)` — this opens the add-source setup picker, *not* a re-auth of the revoked connection. The inline title acknowledges this ("Reconnect starts the supported setup path for this source") but the button label still says "Reconnect" which implies re-authorizing the existing connection. The canonical definition of Reconnect is re-authorizing an existing connection; what this does is start a brand-new setup.  
**Proposed:** `Start new setup`

---

### D-06 — "Reconnect source" in the RevokedConnectionSection navigates to add-source picker

**File:** `apps/console/src/app/dashboard/records/[connector]/page.tsx:678`  
**Current text:** `Reconnect source`  
**Why wrong:** Same issue as D-05. `href={addSourceHrefForConnector(connectorId)}` routes to the add-source flow. The description text already says "reconnect starts a fresh setup path" but that's circular — starting a fresh setup IS the problem; the label should say so plainly.  
**Proposed:** `Start new setup`

---

### D-07 — "Reconnect" in FailureExpander fires for `blocked` state regardless of root cause

**File:** `apps/console/src/app/dashboard/records/[connector]/page.tsx:801`  
**Current text:** `Reconnect` (rendered when `summary.cta === "reconnect"`, which is always true for `blocked` state, including source-pressure `blocked`)  
**Why wrong:** `deriveFailureSummary()` (`connection-evidence.ts:1625–1634`) assigns `cta: "reconnect"` unconditionally for any `blocked` state. But `synthesizeConnectionVerdict()` at line 1119–1123 already handles the source-pressure case correctly (suppressing the "blocked" label and setting `handlingItself: true`). The `FailureExpander` bypasses the synthesis path and reads raw state, so a rate-limited connection that `synthesizeConnectionVerdict` correctly identifies as self-resolving can still show "Reconnect" in the expander.  
**Proposed:** `deriveFailureSummary` should mirror `isSourcePressureCooldown` and set `cta: "wait"` when source pressure is the root cause, matching the synthesis behavior.

---

### D-08 — "Reconnect" inline in auto-paused run-timeline banner for terminal scheduler stop

**File:** `apps/console/src/app/dashboard/records/[connector]/page.tsx:906`  
**Current text:** `Reconnect` (link in `AutoPausedBannerRow` when `banner.isTerminal === true`)  
**Why wrong:** The auto-paused banner fires after consecutive run failures. The "Reconnect" link goes to `addSourceHrefForConnector` — the setup picker. This is correct for credential failures but the banner fires for *any* terminal stop, including source-pressure exhaustion. The mismatch between "terminal" (auto-paused) and "Reconnect" (implies credential re-auth) misleads users.  
**Proposed:** Link label should be "Start new setup"; a separate "or try a manual run" suggestion can remain.

---

### D-09 — Revoked-connection notice in row peek says "use Reconnect" but the correct action is elsewhere

**File:** `apps/console/src/app/dashboard/records/connector-row.tsx:489`  
**Current text:** `Future collection is stopped. Retained records stay visible; use Reconnect to start a fresh setup path for this source.`  
**Why wrong:** The text instructs users to "use Reconnect" — but the row's revoked action (per the code above it) is labeled "Start new setup" (line 250), not "Reconnect." This creates a vocabulary mismatch in the same row: the peek says "Reconnect", the button says "Start new setup."  
**Proposed:** `Future collection is stopped. Retained records stay visible; use "Start new setup" to begin a new setup for this source.`

---

### D-10 — "Packaged path pending" is opaque jargon

**File:** `apps/console/src/app/dashboard/lib/source-add-support.ts:49`  
Also: `apps/console/src/app/dashboard/lib/source-setup-presentation.ts:89,99`  
**Current text:** `"Packaged path pending"`  
**Why wrong:** This chip appears when a source is browser-bound and the in-dashboard add-account path is not yet shipped. The phrase "packaged path" is internal engineering vocabulary with no user-facing meaning. A non-technical owner reads it as "something is pending" with no idea what.  
**Proposed:** `"Setup coming soon"` or `"Browser setup not yet available in dashboard"`

---

### D-11 — "Existing data only" is ambiguous about the user's capability

**File:** `apps/console/src/app/dashboard/lib/source-add-support.ts:53`  
Also: `apps/console/src/app/dashboard/lib/source-setup-presentation.ts:104`  
**Current text:** `"Existing data only"`  
**Why wrong:** This label appears for `not_self_service` sources — those that have data but no shipped owner path to add a new account. "Existing data only" could mean the data is read-only, that the source has data but you cannot add more, or many other things. It does not tell the owner WHY they cannot add another account.  
**Proposed:** `"Can't add another account yet"` or `"No self-service setup available"`

---

### D-12 — "Coverage · unknown" on axis chip is opaque

**File:** `apps/console/src/app/dashboard/lib/connection-evidence.ts:113`  
**Current text:** `label: "Coverage · unknown"`  
**Why wrong:** The label "Coverage · unknown" appears when no durable coverage evidence exists yet. The user sees "unknown" with no explanation of why or what to do. The tooltip (`title`) says "No durable coverage evidence is available yet" — that is the correct human-readable copy, but chip labels must be understandable without hover.  
**Proposed:** `"Coverage · not yet assessed"` or `"Coverage · no data yet"`

---

### D-13 — "Coverage · retryable gap" uses internal jargon

**File:** `apps/console/src/app/dashboard/lib/connection-evidence.ts:82`  
**Current text:** `label: "Coverage · retryable gap"`  
**Why wrong:** "Retryable gap" is an internal scheduler term. The user does not know what a "gap" means in this context (is it a bug? missing data? a date range?), and "retryable" is a programming concept. The corresponding health state label was already improved to "Resuming" (line 1018); the axis chip label should match.  
**Proposed:** `"Coverage · catching up"` (aligns with the "Resuming" badge and the tooltip explanation)

---

### D-14 — "considered unknown" displayed on stream collection-report rows

**File:** `apps/console/src/app/dashboard/lib/collection-report.ts:114`  
**Current text:** `` `${collectedText} collected · considered unknown` ``  
**Why wrong:** "Considered unknown" is internal data-model vocabulary. The `considered` field is the denominator — how many records the connector decided to look at. Telling an owner "considered unknown" requires them to know what "considered" means in PDPP's coverage model. The `title` on the same element provides the correct explanation.  
**Proposed:** `` `${collectedText} collected · scope unknown` `` or `` `${collectedText} collected · total count unknown` ``

---

### D-15 — "N pending gaps" on stream detail uses jargon

**File:** `apps/console/src/app/dashboard/records/[connector]/stream-collection-facts.tsx:78`  
**Current text:** `` `{pendingDetailGaps.toLocaleString()} pending gap{pendingDetailGaps === 1 ? "" : "s"}` ``  
**Why wrong:** "Pending gaps" is scheduler jargon. An owner seeing "52 pending gaps" has no immediate understanding of what a gap is, whether their data is corrupted, or whether this requires action. The tooltip (line 76) correctly explains it: "Recoverable detail gaps the next ordinary run is expected to fill." The chip label should reflect that.  
**Proposed:** `` `{pendingDetailGaps.toLocaleString()} detail item{pendingDetailGaps === 1 ? "" : "s"} still catching up` `` — or at minimum prefix with a calming qualifier: `` `{n} recoverable gap{…}` ``

---

### D-16 — "records present · no scheduler run yet" is lowercase and jargon-y

**File:** `apps/console/src/app/dashboard/records/connector-row.tsx:1046`  
**Current text:** `return <span>records present · no scheduler run yet</span>;`  
**Why wrong:** All-lowercase with a middle-dot separator is an unconventional style for the progress line. "Scheduler run" is internal vocabulary; owners do not know what the "scheduler" is.  
**Proposed:** `Records present · never synced via scheduler`  (or consolidate with "Never run" label)

---

### D-17 — "last sync: never" is lowercase and inconsistent with capitalization of adjacent labels

**File:** `apps/console/src/app/dashboard/records/connector-row.tsx:1049`  
**Current text:** `return <span>last sync: never</span>;`  
**Why wrong:** The adjacent labels (`last success:`, `last attempt:`, `last checked:`, `last ingest:`) all use the same lowercase pattern, but the progress-line labels throughout the rest of the product are capitalized. This group of labels should be reviewed for style consistency.  
**Proposed:** `Last sync: never` (capitalized to match product style)

---

### D-18 — "Partial source coverage" link text is redundant and confusing

**File:** `apps/console/src/app/dashboard/records/connector-row.tsx:571`  
**Current text:** `Partial source coverage`  
**Why wrong:** This is a clickable link in the row peek that navigates to the latest run detail when `hasPartialCoverageHint` is true. "Partial source coverage" reads as a status description, not an action. Users may not know this is clickable or where it leads.  
**Proposed:** `View coverage gaps in latest run →`

---

### D-19 — Shell nav label "Sources" covers connections, creating the root of D-01

**File:** `apps/console/src/app/dashboard/components/shell.tsx:54`  
**Current text:** `{ href: routes.section.records, label: "Sources", match: (a) => a === "records" }`  
**Why wrong:** The nav item "Sources" navigates to the records/connections list — which displays individual *connections*, not a catalog of source *types*. This is the root cause of the vocabulary confusion the owner reported ("Sources (19)" meaning 19 connections). The nav label primes the user to think the page is about source types, not connection instances.  
**Proposed:** `"Connections"` (nav label) — with corresponding rename of the section header at D-01.

---

## 3. Summary

**Total defects found: 19**

**Top 15 defects by impact:**

| # | Severity | File | Current text | Proposed |
|---|----------|------|-------------|----------|
| D-01 | Critical | `records-list-view.tsx:352` | `Sources (${primaryConnections.length})` | `Connections (${n})` |
| D-19 | Critical | `shell.tsx:54` | nav label `"Sources"` | `"Connections"` |
| D-02 | High | `records-list-view.tsx:412` | `Add source` (header button) | `Add connection` |
| D-07 | High | `connection-evidence.ts:1625–1633` | `cta: "reconnect"` for all `blocked` | `cta: "wait"` when source-pressure root cause |
| D-04 | High | `records-list-view.tsx:559` | `Reconnect` (source card, any attention) | `Fix connection` / `Review connection` |
| D-05 | High | `[connector]/page.tsx:365` | `Reconnect` (revoked, goes to setup picker) | `Start new setup` |
| D-06 | High | `[connector]/page.tsx:678` | `Reconnect source` (revoked section) | `Start new setup` |
| D-10 | High | `source-add-support.ts:49` + `source-setup-presentation.ts:89,99` | `"Packaged path pending"` | `"Setup coming soon"` |
| D-03 | Medium | `records-list-view.tsx:590` | `Add source →` (per-source fallback) | `Add connection →` |
| D-09 | Medium | `connector-row.tsx:489` | `use Reconnect to start a fresh setup` | `use "Start new setup"` |
| D-11 | Medium | `source-add-support.ts:53` + `source-setup-presentation.ts:104` | `"Existing data only"` | `"Can't add another account yet"` |
| D-13 | Medium | `connection-evidence.ts:82` | `"Coverage · retryable gap"` | `"Coverage · catching up"` |
| D-14 | Medium | `collection-report.ts:114` | `"…collected · considered unknown"` | `"…collected · scope unknown"` |
| D-15 | Medium | `stream-collection-facts.tsx:78` | `"N pending gaps"` | `"N detail items still catching up"` |
| D-08 | Medium | `[connector]/page.tsx:906` | `Reconnect` (auto-paused terminal banner) | `Start new setup` |

**Remaining defects (D-12, D-16, D-17, D-18) are low severity** — cosmetic wording, capitalization, or redundant labels.

---

## 4. Notes on the owner's Reported Defects

| Reported | Status | Finding |
|---------|--------|---------|
| "Sources (19)" should be "Connections (19)" | **Confirmed** — D-01 + D-19 | `records-list-view.tsx:352` + `shell.tsx:54` |
| "Add source →" on a card that has a connection | **Confirmed** — D-03 | `records-list-view.tsx:590` — fires as fallback when add-another is not self-service |
| "Reconnect" on rate-limited connection | **Partially confirmed** — D-07 | The *row-level synthesis* (`synthesizeConnectionVerdict`) correctly suppresses `blocked` for source-pressure (`handlingItself: true`). But `deriveFailureSummary` (used by the detail-page FailureExpander) does NOT apply the source-pressure check — any `blocked` state gets `cta: "reconnect"`. So the defect exists on the detail page, not on the list-view row. |
| "Packaged path pending" is cryptic | **Confirmed** — D-10 | `source-add-support.ts:49` + `source-setup-presentation.ts:89,99` |
| "Existing data only" is cryptic | **Confirmed** — D-11 | `source-add-support.ts:53` + `source-setup-presentation.ts:104` |
| "Coverage · unknown" | **Confirmed** — D-12 | `connection-evidence.ts:113` |
| "considered unknown" | **Confirmed** — D-14 | `collection-report.ts:114` — appears on stream run-detail rows, not the connection list |
| "retryable gap" / "52 pending gaps" | **Confirmed** — D-13 (axis chip) + D-15 (stream count) | Two separate locations: axis chip label at `connection-evidence.ts:82`; count display at `stream-collection-facts.tsx:78` |
