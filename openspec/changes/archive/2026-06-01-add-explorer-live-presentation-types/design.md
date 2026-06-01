# Design — Explorer live presentation types (flagship pilot)

Status: proposed
Owner: reference implementation owner-delegate
Created: 2026-05-31
Related: openspec/changes/archive/2026-05-31-complete-explorer-slvp-ideal, design-notes/explorer-record-kind-and-typed-manifest-2026-05-28.md, tmp/workstreams/ri-explorer-slvp-owner-audit-v1-report.md

## Problem

The typed-card path is accepted and green but dormant on live data. The audit
verdict was ~90% confidence (not the claimed >95%) because live rows fall to the
one-line heuristic instead of designer-grade typed cards, and the only browser
proof was gitignored. This change closes the manifest-typing root cause for a
two-connector pilot and writes the exact UAT runbook the audit asked for.

## Material correction to prior lanes: the designer artifact exists

Prior Explorer lanes recorded that `PDPP Explorer.html` returned `not found`
every time (see `ri-explorer-slvp-owner-audit-v1-report.md` residual risks). That
is no longer true. The artifact is present and reviewable at:

- `tmp/designs/pdpp-explorer/PDPP-Explorer.html` (≈580 KB, gitignored)
- `tmp/designs/pdpp-explorer/pdpp-design-system/project/PDPP Explorer.html`

It was read for this change. It is a self-contained, data-driven React SPA — not
a static screenshot. Findings that bear on this pilot:

- The design dispatches **eight** card kinds (`message`, `money`, `photo`,
  `event`, `activity`, `reader`, `location`, `generic`) via `CARD_BY_KIND`,
  keyed off a `cardKindForStream()` that reads declared schema field `type`s.
- A "Why these views?" popover states explicitly that "connector identity is
  irrelevant … lit up from the stream's typed schema fields." The design is
  **type-driven by construction**, which is exactly what this pilot supplies for
  real connectors.
- The reference Explorer already matches the design's IA (connection-first
  facets, day-grouped feed, peek panel, search/timeline lenses) and ships five
  of the eight kinds (`message`, `money`, `event`, `titled`, `generic`). The
  design's `photo`/gallery, `activity`/chart, `reader`, `location`/map cards, the
  per-stream view switcher, and the grant-projection/`redacted_reason` toggle are
  NOT matched and are deliberately out of scope here.

Honesty note for the owner: this pilot makes money + message cards real on live
data. It does not reach full designer parity. The remaining card kinds and the
view switcher are a larger, separate tranche.

## Why a two-connector pilot, not a rollout

- The risk is in the *first* real declarations and the proof that they flow
  end-to-end, not in volume. Two connectors prove both card kinds the reference
  ships and the full path; the marginal value of connectors 3–30 is rollout, not
  confidence.
- It keeps the diff auditable: two manifests, additive `x_pdpp_type` keys only,
  plus one test file.
- A 30-connector rollout is explicitly the broad work the lane brief forbids.

## Connector and field selection

The dispatch precedence in `record-kind.ts` is: money > (person+text → message) >
text → titled > temporal → event. The pilot fields are chosen to land the
intended kind cleanly under that precedence.

### chase `transactions` → `money`

Real schema fields (`packages/polyfill-connectors/manifests/chase.json`):
`id, account_id, account_name, fitid, date, amount, currency, type, name, memo, …`.

| Field    | `x_pdpp_type` | Rationale |
| -------- | ------------- | --------- |
| `amount` | `currency`    | Strongest signal; forces a `money` card. The transaction amount is the headline value the money card leads with. |
| `date`   | `timestamp`   | Drives the event-time element of the card; honest temporal type. |
| `name`   | `text`        | The merchant/payee display string the money card shows as its title. |

`currency` (the ISO currency code field) is intentionally **not** typed
`currency` — that field is a 3-letter code, not a monetary amount; typing it
`currency` would misrepresent it. Only `amount` carries the monetary type. This
respects the design's "never invent a field shape the declared type does not
assert" rule.

### gmail `messages` → `message`

Real schema fields (`packages/polyfill-connectors/manifests/gmail.json`):
`id, thread_id, subject, from_name, from_email, to, …, date, …, snippet`.

| Field       | `x_pdpp_type` | Rationale |
| ----------- | ------------- | --------- |
| `from_name` | `person`      | The author/sender; pairs with text to dispatch `message`. |
| `subject`   | `text`        | The message title line. |
| `snippet`   | `text`        | The message body preview the card renders. |
| `date`      | `timestamp`   | The message time in the card eyebrow. |

`person` + `text` satisfies the message-dispatch branch
(`hasPerson && hasText → "message"`).

## Why this is additive and safe

- `x_pdpp_type` lives on existing `schema.properties` entries. The server's
  `buildFieldCapabilities` (`reference-implementation/server/index.js:1836-1882`)
  reads it as a presentation-only key and explicitly does not let it influence
  filter, range, lexical, semantic, aggregation, grant, or retrieval decisions.
  The accepted change's own test (`rs-streams-field-declared-type.test.js`)
  proves a declared-type field carries byte-identical capability flags to an
  undeclared twin.
- The Explorer treats an absent `type` as "not declared" and falls back to the
  heuristic, so connectors without declarations are unaffected.
- No server, contract, or runtime code changes. The only behavior change is that
  two connectors' rows now dispatch typed cards instead of the heuristic.

## Evidence harness (the no-runtime-risk artifact this lane commits)

A test that proves the live path against the **real committed manifests**, not a
synthetic fixture:

1. Load the actual `chase.json` and `gmail.json` manifests.
2. Register each through the AS and read `GET /v1/streams/:stream` under an owner
   token (mirroring `rs-streams-field-declared-type.test.js`'s HTTP harness).
3. Assert the pilot fields surface the expected `field_capabilities[].type` and
   that non-pilot fields omit `type`.
4. Feed the surfaced `field_capabilities` types into the real `classifyRecordKind`
   and assert `chase/transactions → money` and `gmail/messages → message`.

This makes the pilot's central claim — "typed cards render on real data" —
provable in CI with zero browser dependency, and it guards against manifest drift
silently breaking the dispatch.

## Browser/UAT runbook (follow-up; NOT produced in this worktree)

This worktree has no running reference stack, so no pixel evidence is created
here. The audit's "loose gitignored PNG" gap is closed by a *separate* lane that
follows this one. The exact runbook for that lane:

```bash
# 1. Start the reference stack + dashboard (root README.md:62-79)
pnpm dev   # AS :7662, RS :7663, web :3000

# 2. Mint an owner token and seed real-shaped data for chase + gmail
#    (docs/local-testing-e2e.md). Use captured fixtures per the
#    fixture-first-debugging rule; do not run fresh OTP cycles unless needed.

# 3. Load and capture, committing into a TRACKED path:
#    /dashboard/explore  (recent lens)   -> expect a money card on a chase
#                                            transaction row and a message card
#                                            on a gmail messages row
#    /sandbox/explore                     -> already renders typed cards
#    Capture both into docs/explorer/uat/<commit>/*.png (tracked, not tmp/).
```

Acceptance for the follow-up UAT lane (the >95% gate, below) is: a chase
transaction renders a money card and a gmail message renders a message card on
`/dashboard/explore` against real-shaped data, captured into a commit-anchored
path, side-by-side with the sandbox equivalent to make the live-vs-sandbox delta
explicit.

## Acceptance criteria for >95% Explorer live-fidelity confidence

The audit's 90→95 delta is the live-data typed-card axis plus commit-anchored
proof. This pilot + its follow-up UAT lane close it when ALL hold:

1. Two flagship manifests (`chase`, `gmail`) declare presentation types on the
   pilot fields. (this change)
2. The evidence harness proves real-manifest → `field_capabilities[].type` →
   `record-kind` dispatch (`money`, `message`) end-to-end and green. (this change)
3. Declared types remain provably additive — no capability-flag, grant, or
   retrieval change. (re-uses the accepted change's invariant test; re-asserted
   here for the real manifests)
4. A commit-anchored browser pass shows a real chase transaction as a money card
   and a real gmail message as a message card on `/dashboard/explore`, captured
   into a tracked path. (follow-up UAT lane)
5. The live-vs-sandbox fidelity delta is explicit and owner-visible: the same two
   rows side-by-side in `/dashboard/explore` and `/sandbox/explore`. (follow-up
   UAT lane)
6. The remaining designer-parity gap (photo/activity/reader/location cards, view
   switcher, grant-projection toggle) is recorded as known-and-scoped-out, so
   ">95% live fidelity" is claimed against the *money + message* card axis, not
   against full designer parity.

## Alternatives considered

- **UAT-evidence-first lane instead of this pilot.** Rejected as the first
  change: it proves the gap but does not close it, and no pixel evidence can be
  produced in this worktree. Closing the manifest-typing root cause moves
  confidence more and ships committed artifacts. The UAT runbook is preserved
  above as the follow-up.
- **Roll declared types to all connectors now.** Rejected: explicitly out of the
  lane brief; risk is in the first declarations + proof, not in volume.
- **Use the sandbox-shaped `fields[]` declaration array instead of
  `x_pdpp_type`.** Rejected: the live manifests already carry rich
  `schema.properties`; adding `x_pdpp_type` to existing properties is the
  smallest, most local diff and matches how the live manifest type
  (`ManifestFieldSchema.x_pdpp_type`) is shaped.
