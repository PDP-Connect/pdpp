# Explorer live-fidelity UAT — money + message cards on live data

**Head commit:** `10fb2f59` (branch `workstream/ri-explorer-live-uat-proof-v1`, base `main`)
**Captured:** 2026-05-31, no human in the loop.
**Change under proof:** `add-explorer-live-presentation-types` (chase + gmail manifest pilot, accepted on `main`).

This directory is the commit-anchored browser/UAT artifact the SLVP audit
(`tmp/workstreams/ri-explorer-slvp-owner-audit-v1-report.md`, P1 "browser proof
is loose and uncommitted") and the change `design.md` (acceptance criteria 4–5)
asked for. It replaces the prior loose, gitignored PNGs with tracked evidence
tied to a specific commit.

## What this proves

A real chase `transactions` row renders a **money card** and a real gmail
`messages` row renders a **message card** on the live `/dashboard/explore`
surface, driven by the manifests' declared `x_pdpp_type` presentation types —
not the stream-name heuristic, and not a synthetic sandbox fixture.

The evidence chain is end-to-end on a **running reference stack**:

1. The real committed `chase.json` + `gmail.json` manifests are registered
   through the AS.
2. Synthetic, real-shaped records (no PII) are seeded through the **public**
   `POST /v1/ingest/:stream` path (`docs/explorer/uat/harness/fixtures.mjs`).
3. The RS surfaces the declared `field_capabilities[].type` on the live read
   path (`chase.amount=currency`, `chase.date=timestamp`, `chase.name=text`;
   `gmail.from_name=person`, `gmail.subject/snippet=text`, `gmail.date=timestamp`),
   and non-pilot fields (`chase.memo`, `gmail.from_email`) omit `type`.
4. The Next.js dashboard mints its own owner token, reads those records, and the
   Explorer's `classifyRecordKind` dispatches typed cards from the declared
   types.

### Machine-verifiable result (`probe.json`)

The capture script inspects the rendered DOM and counts cards by their
kind hairline (`before:bg-primary` = money, `before:bg-[color:var(--human)]` =
message, `before:bg-border` = generic):

| Surface | total | money | message | generic |
| --- | --- | --- | --- | --- |
| `/dashboard/explore` (live-seeded chase+gmail) | 10 | **5** | **5** | 0 |
| `/sandbox/explore` (typed-card reference) | 9 | 9 | 0 | 0 |

All 5 seeded chase transactions dispatched to money cards; all 5 seeded gmail
messages dispatched to message cards. **Zero rows fell to the generic one-line
heuristic** — the exact failure mode the audit flagged on live data is gone for
these two connectors.

## Files

- `dashboard-explore.png` — `/dashboard/explore` against the live-seeded
  chase+gmail stack. Alternating money cards (chase, blue hairline,
  right-aligned amount) and message cards (gmail, copper hairline, subject +
  snippet body).
- `sandbox-explore.png` — `/sandbox/explore` typed-card reference (mock data,
  no runtime). Side-by-side, this makes the live-vs-sandbox delta explicit.
- `probe.json` — the DOM probe output backing the table above (rendered card
  counts + sampled amounts/authors per surface).

## What this does NOT prove (honest scope)

- **Designer parity is out of scope.** This proves the *money + message* card
  axis only. The designer artifact's photo/activity/reader/location cards, the
  per-stream view switcher, and the grant-projection/`redacted_reason` toggle
  are a separate, larger tranche (see `design.md` §"the designer artifact
  exists"). ">95% live fidelity" is claimed against money + message dispatch,
  not full designer parity.

- **Money-amount value formatting is a real, separate fidelity bug — card
  dispatch is correct, the rendered number is not.** Chase's `amount` is
  integer **cents** (`-1245` = −$12.45). The Explorer's money preview
  (`apps/web/src/app/dashboard/lib/record-preview.ts:91-92`) formats a bare
  `amount` field with a YNAB-milliunits heuristic (`÷1000` when `|amount|>10000`,
  else whole dollars), so on live chase data it renders `-$1245.00` and
  `$438.12` instead of `-$12.45` and `$4381.20`. The card **kind** is right
  (money); the **value** is misread because the preview heuristic does not yet
  consult the declared `currency` type or chase's cents convention. The sandbox
  amounts format correctly only because the sandbox demo data uses the
  milliunits convention the heuristic assumes. This is NOT fixed by this
  evidence lane (which is scoped to dispatch proof, not preview formatting); it
  is recorded here for the owner. Suggested next slice: have the money preview
  honor a declared `currency` type + a per-field cents/milliunits signal.

- The data is synthetic (real-shaped, no PII), seeded via ingest — not a live
  bank/email collection run. That is intentional and required by the lane brief.

## Reproduce

The reproducible driver is the tracked harness at `docs/explorer/uat/harness/`
(`fixtures.mjs`, `seed-and-serve.mjs`, `capture.mjs`). From a deps-installed
checkout at this commit (ports 7762/7763 + 3300/3301 are used to avoid colliding
with any already-running stack on the defaults):

```bash
# 1. Seed + serve the isolated reference stack (registers the real chase+gmail
#    manifests, seeds synthetic records, verifies declared types surface):
AS_PORT=7762 RS_PORT=7763 node docs/explorer/uat/harness/seed-and-serve.mjs   # stays alive

# 2. Dashboard pointed at the isolated stack, owner gate disabled:
cd apps/web && PDPP_AS_URL=http://localhost:7762 PDPP_RS_URL=http://localhost:7763 \
  PDPP_REFERENCE_ORIGIN=http://localhost:3300 PDPP_ENABLE_DASHBOARD=1 \
  PDPP_DASHBOARD_AUTH_REDIRECT=0 PDPP_WEB_PORT=3300 \
  pnpm exec next dev --webpack --port 3300

# 3. Site app for the sandbox reference:
cd apps/site && pnpm exec next dev --webpack --port 3301

# 4. Capture both surfaces into a commit-anchored directory:
node docs/explorer/uat/harness/capture.mjs docs/explorer/uat/<short-head>
```

`seed-and-serve.mjs` is self-verifying: it asserts the declared
`field_capabilities[].type`s surface and the seeded records read back before it
reports `READY`, so a manifest drift that broke the live typed-card dispatch
would fail the harness rather than silently producing a wrong screenshot.
