# Design-Note Triage — 2026-04-24

93 notes classified across three locations. Classifications use the categories in `clean-up-openspec-corpus/tasks.md §3.4`:

- **promote**: decision is ripe enough to enter an OpenSpec change or root PDPP spec.
- **sprint-needed**: high-stakes enough that owner/design sprint is the right next step before promotion.
- **defer**: legitimate but parked until a second forcing function.
- **superseded**: resolved by another artifact; candidate for deletion or pointer-only retention.
- **connector-background**: per-connector documentation. Belongs *with* the connector code, not in an intake lane.
- **historical**: captures work already landed; retained for archaeology.

Recommendations are advisory. Nothing is moved or deleted in this report.

## Root `design-notes/` (3 files, incl. `README.md`)

| Note | Header compliant? | Classification | Recommendation |
| --- | --- | --- | --- |
| `README.md` | n/a (is itself the template) | infrastructure | Keep. Canonical header definition. |
| `broad-storage-abstraction-2026-04-24.md` | **yes** (`Status: decided-defer`) | **defer** | Keep at root. Already the exemplar of the new header format. Referenced by `reference-implementation-program/tasks.md` line 308. |
| `source-instances-and-multi-account-configurations-2026-04-24.md` | **yes** (`Status: captured`) | **sprint-needed** | Cross-cuts polyfill connector configuration + grant identity. Should be paired with APCS `connector-configuration-open-question.md` in the same sprint. |

## `openspec/changes/reference-implementation-program/design-notes/` (43 files)

Most of this directory is now historical research supporting phases that have shipped or rubric memos the owner wrote for retrieval decisions. Almost nothing here is active intake.

### Historical (program phases landed, note retained for archaeology)

- `control-plane-backing-surface-audit-2026-04-21.md`
- `control-plane-discovery-brief.md`
- `control-plane-implementation-plan.md`
- `control-plane-live-ux-audit-2026-04-21.md`
- `control-plane-runtime-control-surface-audit-2026-04-21.md`
- `control-plane-ui-audit-2026-04-21.md`
- `control-plane-v1-follow-up.md`
- `dashboard-hero-code-audit-2026-04-22.md`
- `dashboard-hero-compositions-2026-04-22.md`
- `dashboard-hero-plan-2026-04-22.md`
- `dashboard-hero-prior-art-linear-2026-04-22.md`
- `dashboard-hero-prior-art-plaid-2026-04-22.md`
- `dashboard-hero-prior-art-stripe-2026-04-22.md`
- `dashboard-hero-prior-art-vercel-2026-04-22.md`
- `dashboard-hero-synthesis-2026-04-22.md`
- `dashboard-typography-lint-2026-04-23.md`
- `reference-implementation-execution-plan-2026-04-21.md`
- `reference-surface-assessment-2026-04-20.md`
- `single-origin-reference-composition-plan-2026-04-22.md`
- `reference-local-third-party-connect-defaults-2026-04-22.md`
- `owner-auth-placeholder-open-question-2026-04-22.md` (decision landed; file title still says "open question")
- `record-query-contract-audit-2026-04-21.md`
- `record-query-contract-proposed-direction-2026-04-21.md`
- `record-query-contract-research-2026-04-21.md`
- `record-query-contract-review-2026-04-21.md`
- `reference-contract-response-schema-drift-2026-04-22.md`
- `lexical-retrieval-launch-worker-brief-2026-04-23.md`
- `personal-assistant-readiness-audit-2026-04-23.md`
- `pre-existing-test-failures-triage-2026-04-22.md`
- `openspec-explorer-execution-plan-2026-04-22.md`
- `blob-id-param-naming-2026-04-22.md` (explicitly titled "Resolved —")

**Recommendation**: retain in place. When `reference-implementation-program` is archived (inventory §RIP), these travel with the archived change into `openspec/changes/archive/`. Rewrite the `reference-implementation-program/design.md` references named in the inventory so they do not dead-end after archive: either (a) relocate the handful of cited notes (control-plane brief + plan + follow-up, dashboard-hero plan, owner-auth placeholder, single-origin composition, reference-local third-party defaults) to `design-notes/` at the root, or (b) rewrite `design.md` so the decisions those notes captured are inlined.

### Promote (decisions ripe for one of the active changes)

- `lexical-retrieval-status-options-2026-04-23.md` — owner decision memo on status of lexical retrieval. Already reflected in canonical spec `lexical-retrieval/spec.md`. **Recommendation**: promote as "settled — canonical spec encodes this decision." Convert to a pointer note or move to root `design-notes/` as `decided-promote` under the canonical header.
- `semantic-retrieval-status-options-2026-04-23.md` — same shape as above but for semantic retrieval. Canonical spec now exists. **Recommendation**: same treatment as the lexical memo.
- `semantic-retrieval-experimental-extension-2026-04-23.md` — execution brief. **Recommendation**: the active change `make-semantic-retrieval-operational` should cite this note explicitly in its `design.md`. Classification **promote** via citation, retain as program-historical artifact.
- `semantic-retrieval-first-implementation-shape-2026-04-24.md` — owner recommendation on first implementation shape. **Recommendation**: the active change `make-semantic-retrieval-operational` should cite this in its `design.md` as "see first-implementation-shape" since §§4–5 execution shape depends on this recommendation. Classification **promote** via citation.
- `semantic-retrieval-metadata-carrier-2026-04-23.md` — carrier/discovery boundary decision. **Recommendation**: `make-semantic-retrieval-operational/design.md` should inline or cite. **promote** via citation.
- `semantic-retrieval-reference-experiment-2026-04-23.md` — experiment brief. **Recommendation**: overlaps `semantic-retrieval-first-implementation-shape`. Classification **superseded** by the 2026-04-24 shape note if the owner confirms; otherwise citation from `make-semantic-retrieval-operational`.
- `surface-status-ladder-2026-04-23.md` — rubric. **Recommendation**: cross-cutting rubric. **promote** to root `design-notes/` (rename to `surface-status-ladder.md`) so it's authoritative across future changes, not tied to the archived RIP.
- `capability-discovery-framing-2026-04-22.md`, `capability-discovery-options-2026-04-22.md`, `capability-discovery-research-audit-2026-04-22.md` — framing + options + audit on capability discovery. Status unclear. **Recommendation**: **promote** if a capability-discovery change is queued; otherwise **sprint-needed** to reach a decision. At minimum the framing note should move to root so it isn't orphaned when RIP archives.

### Open question still open

- `express-5-query-parser-open-question-2026-04-22.md` — concrete implementation concern tied to record-query contract. **Recommendation**: **promote** to `swap-sqlite-driver` (if that stays open) or to a new query-contract hardening change. If neither happens this cycle, classify **defer** with a root-level pointer note.

### Normalization targets (highest value, surface regularly)

The notes most worth normalizing to the canonical header now (so they stop looking like historical program memos when they're actually still load-bearing):

1. `surface-status-ladder-2026-04-23.md` — needs canonical header because it's becoming a cross-cutting rubric that outlives RIP.
2. `semantic-retrieval-first-implementation-shape-2026-04-24.md` — actively steers `make-semantic-retrieval-operational`.
3. `semantic-retrieval-metadata-carrier-2026-04-23.md` — same.
4. `capability-discovery-framing-2026-04-22.md` — will survive RIP archive as cross-cutting.

## `openspec/changes/add-polyfill-connector-system/design-notes/` (50 files)

This directory has four very different kinds of note mixed together. Triaged by sub-group below.

### Connector-background (retain with connector code, not as intake)

| Note | Recommendation |
| --- | --- |
| `amazon.md` | Move to `packages/polyfill-connectors/connectors/amazon/DESIGN.md` (or keep here if APCS is not archiving). |
| `amazon-v02-plan.md` | Same. |
| `chase.md` | Same. |
| `chase-anti-bot.md` | Same. |
| `chatgpt.md` | Same. |
| `claude-code-codex-connectors.md` | Same; covers both. |
| `gmail.md` | Same. |
| `gmail-jsonl-truncation-bug.md` | Bug postmortem — **historical**; retain with connector code. |
| `slackdump-design-gaps.md` | **historical** bug-postmortem for slackdump fleet fix; retain with connector. |
| `usaa.md` | **connector-background**. |
| `usaa-extra-streams.md` | **connector-background**; referenced by APCS Layer 2 backlog. |
| `usaa-historical-coverage-gap.md` | **connector-background**; still actionable backlog. |
| `ynab.md` | **connector-background**. |

**Recommendation**: if APCS is split (inventory §APCS), connector-background notes move to `packages/polyfill-connectors/connectors/<name>/` so they live next to the code. If APCS stays one change, keep them here but re-label the section so they read as connector docs, not open questions.

### Historical (shipped or overtaken)

- `0-overnight-summary.md` — 2026-04-19 overnight recap. **historical**.
- `wide-build.md` — 2026-04-19 overnight expansion batch. **historical**.
- `spec-conformance-upgrade-2026-04-19.md` — retrofit table. **historical**, still useful pointer.
- `dashboard-design-upgrade-todos.md` — deferred-until-data-pristine. **defer** with a root pointer if still active intent, else **historical**.
- `platform-bootstrap-research.md` — pre-work research. **historical**.
- `private-generated-connector-pilot-brief-2026-04-23.md`, `private-generated-connector-source-selection-2026-04-23.md` — pilot briefs. **sprint-needed** if pilot is still queued, else **historical**.
- `unattended-operation.md` — principle doc, still load-bearing. **promote** to root `design-notes/` so it survives APCS changes.
- `sqlite-performance-recommendations.md` — **historical** reference for runtime tuning; retain as pointer.
- `playwright-hygiene.md` — known tech-debt list. Already surfaced in memory as `feedback_playwright_hygiene`. **historical** / pointer.
- `parent-first-emit-order-decision-2026-04-23.md` — decision landed (see APCS tasks Tranche C). **superseded** by the task + authoring-guide update; convert to pointer.

### Open-question notes (15)

| Note | Recommendation | Reasoning |
| --- | --- | --- |
| `partial-run-semantics-open-question.md` | **promote** — trio with next two | APCS tasks explicitly say "must be decided together." Proposal: new change `define-partial-run-honesty-mechanism` covering the three together. |
| `cursor-finality-and-gap-awareness-open-question.md` | **promote** with partial-run | Same trio. |
| `gap-recovery-execution-open-question.md` | **promote** with partial-run | Same trio. |
| `blob-hydration-open-question.md` | **sprint-needed** | Gmail attachments already plan to use this pattern (APCS task line 216). Worth a decision sprint before another connector needs it. |
| `connector-configuration-open-question.md` | **sprint-needed** | Paired with root `source-instances-and-multi-account-configurations-2026-04-24.md`. Together they are one sprint. |
| `credential-storage-open-question.md` | **sprint-needed** | `.env.local` is acknowledged as the wrong answer. Decision cannot wait much longer. |
| `rs-storage-topology-open-question.md` | **defer** | Today's split (Codex under `PDPP_DB_PATH`) is tactical. Leave as `decided-defer` unless a second deployment target appears. |
| `layer-2-completeness-open-question.md` | **promote** — would become part of a Layer 2 follow-up change (inventory §APCS). |
| `owner-self-export-open-question.md` | **promote** | Directly implies a new `GET /v1/connectors` / bulk-export surface. Should become its own proposal if pursued, or a note on `reference-native-provider-boundary`. |
| `settings-stream-convention-open-question.md` | **defer** | Legitimate but cross-connector. No forcing function yet. |
| `identity-graph-open-question.md` | **defer** | Same. |
| `authored-artifacts-vs-activity-open-question.md` | **sprint-needed** | Top-ranked gap in all Layer 2 audits; overdue for an owner decision pass. |
| `account-risk-from-repeated-automation-open-question.md` | **sprint-needed** | USAA lockout already happened. Real risk, not hypothetical. |
| `external-tool-dependencies-open-question.md` | **sprint-needed** | slackdump + osxphotos + Playwright are invisible to consent/spec; auditors will ask. |
| `debugging-leverage-open-question.md` | **defer** | Quality-of-life investigation. |
| `browser-automation-tools-open-question.md` | **defer** | Research until a concrete new connector forces the decision. |
| `agent-generated-custom-connectors-open-question-2026-04-23.md` | **defer** | Research. |
| `platform-archive-requests-open-question.md` | **defer** | Research. |
| `raw-provenance-capture-open-question.md` | **defer** | Research. |
| `credential-bootstrap-automation-open-question.md` | **defer** | Follow-up to GitHub PAT bootstrap pattern. |
| `partial-run-semantics-open-question.md`, `cursor-finality-and-gap-awareness-open-question.md`, `gap-recovery-execution-open-question.md` | (see promote row above) | |
| `rs-api-discoverability-open-question.md` | **sprint-needed** | Discoverability + error-shape + query semantics. Pair with record-query-contract work. |
| `semantic-retrieval-surface-open-question.md` | **superseded** by `openspec/specs/semantic-retrieval/spec.md` + `make-semantic-retrieval-operational` | Retain pointer; decision is captured. |

### Coverage audits

- `layer-2-coverage-chatgpt-claude-codex.md` — **historical** audit; the resulting P0 list is already in APCS `tasks.md`. Retain as evidence.
- `layer-2-coverage-gmail-ynab-usaa-github.md` — same.

### Framing

- `pdpp-trust-model-framing.md` — cross-cutting framing that several notes cite. **promote** to root `design-notes/` and rename canonically (e.g., `trust-model-framing.md`) so it's a durable reference outside APCS.

### Normalization targets (highest value, surface regularly)

The notes most worth normalizing to the canonical `Status: / Owner: / Created: / Updated: / Related:` header now:

1. `partial-run-semantics-open-question.md`, `cursor-finality-and-gap-awareness-open-question.md`, `gap-recovery-execution-open-question.md` — trio is promote-ready; canonical headers make that legible.
2. `unattended-operation.md` — load-bearing principle doc that will outlive APCS.
3. `pdpp-trust-model-framing.md` — cross-cutting framing.
4. `blob-hydration-open-question.md`, `connector-configuration-open-question.md`, `credential-storage-open-question.md` — sprint-needed notes that owner will return to soon.

## Normalization applied in this cleanup change

Per `clean-up-openspec-corpus/tasks.md §3.5`, only the **highest-value active-intake notes** get canonical headers rewritten in this pass. Historical + connector-background + `decided-defer` notes are not touched. The targeted set (seven notes):

1. `openspec/changes/add-polyfill-connector-system/design-notes/partial-run-semantics-open-question.md`
2. `openspec/changes/add-polyfill-connector-system/design-notes/cursor-finality-and-gap-awareness-open-question.md`
3. `openspec/changes/add-polyfill-connector-system/design-notes/gap-recovery-execution-open-question.md`
4. `openspec/changes/add-polyfill-connector-system/design-notes/blob-hydration-open-question.md`
5. `openspec/changes/add-polyfill-connector-system/design-notes/connector-configuration-open-question.md`
6. `openspec/changes/add-polyfill-connector-system/design-notes/credential-storage-open-question.md`
7. `openspec/changes/add-polyfill-connector-system/design-notes/pdpp-trust-model-framing.md`

Plus one rubric note that should move to root as part of program decomposition (§5), not §3 normalization:

- `openspec/changes/reference-implementation-program/design-notes/surface-status-ladder-2026-04-23.md`

Actual header normalization is a follow-up edit, not part of the reports. Recommendation: leave `Status:` values at their current semantic (open / sprint-needed / captured), add canonical `Owner:`/`Created:`/`Updated:`/`Related:` fields, preserve existing body wholesale.

## Summary counts

| Classification | RIP | APCS | Root | Total |
| --- | --- | --- | --- | --- |
| promote | 7 | 4 + trio | 0 | ~14 |
| sprint-needed | 3 | 7 | 1 | 11 |
| defer | 0 | 7 | 1 | 8 |
| superseded | ~3 | 2 | 0 | ~5 |
| connector-background | 0 | 13 | 0 | 13 |
| historical | 31 | 10 | 0 | 41 |
| infrastructure (README) | 0 | 0 | 1 | 1 |

Total rows sum to more than 93 because some notes are cited in two categories (e.g., "historical, but retain pointer"). The number to anchor to is: **93 notes, ~75% historical or connector-background, ~25% live intake worth owner attention.**
