# Explorer live-fidelity UAT — money-amount fix RECAPTURE

**Head commit:** `97dc8b80` (branch `workstream/ri-explorer-post-money-recapture-v1`, base `main`)
**Captured:** 2026-05-31, no human in the loop.
**Change under proof:** the money-format fix `fix(explorer): format declared-currency
amounts as cents on live data` (`62a9d765`), on `main`.

This directory is the **post-fix recapture** of the live UAT. It re-runs the exact
same tracked harness (`docs/explorer/uat/harness/`) and the same synthetic
real-shaped fixtures as the prior `10fb2f59/` artifact, against current `main`
(`97dc8b80`), to prove the money-amount formatting bug that `10fb2f59` recorded
as an open fidelity gap is now closed on the live `/dashboard/explore` surface.

## What `10fb2f59` left open, and what this closes

`10fb2f59/README.md` honestly flagged that card **dispatch** was correct but the
rendered money **value** was wrong on live chase data: chase `amount` is signed
integer **cents** (`-1245` = −$12.45), but the Explorer money preview formatted a
bare `amount` with a magnitude-only milliunits heuristic (`÷1000` when
`|amount| > 10000`, else whole dollars). That artifact's `probe.json` literally
captured the bug on `/dashboard/explore`.

`62a9d765` fixed it: the money preview now resolves a bare `amount`'s unit from
its declared `field_capabilities[].type` (`currency` → cents ÷100), falling back
to the legacy magnitude heuristic only when no type is declared. This recapture
proves the fix end-to-end on the running stack.

### Live `/dashboard/explore` amounts — before vs. after (same fixtures)

| Fixture `amount` | declared type | `10fb2f59` (pre-fix) | `97dc8b80` (this) | true value |
| ---: | --- | ---: | ---: | ---: |
| `-1245`   | `currency` | `-$1245.00` ❌ | **`-$12.45`** ✅ | −$12.45 |
| `438120`  | `currency` | `$438.12` ❌   | **`$4381.20`** ✅ | $4,381.20 |
| `-8900`   | `currency` | `-$8900.00` ❌ | **`-$89.00`** ✅ | −$89.00 |
| `-2840`   | `currency` | `-$2840.00` ❌ | **`-$28.40`** ✅ | −$28.40 |
| `-15600`  | `currency` | `-$15.60` ❌¹  | **`-$156.00`** ✅ | −$156.00 |

¹ `-15600` was mis-divided the *other* way pre-fix: `|amount| > 10000` sent it
through the `÷1000` milliunits branch, so it rendered `-$15.60`. The declared
`currency` type now pins it to cents regardless of magnitude.

The live dashboard's first two amounts (`-$12.45`, `$4381.20`) now exactly match
the `/sandbox/explore` typed-card reference — the live-vs-sandbox value delta the
prior artifact documented is gone.

### Machine-verifiable result (`probe.json`)

Same DOM probe as `10fb2f59` (cards counted by kind hairline; amounts read from
`span.font-mono.tabular-nums`):

| Surface | total | money | message | generic |
| --- | --- | --- | --- | --- |
| `/dashboard/explore` (live-seeded chase+gmail) | 10 | **5** | **5** | 0 |
| `/sandbox/explore` (typed-card reference) | 9 | 9 | 0 | 0 |

All 5 chase rows → money cards with correct cents amounts; all 5 gmail rows →
message cards; **zero generic fallbacks**. The message-card proof from `10fb2f59`
did not regress.

## Files

- `dashboard-explore.png` — `/dashboard/explore` against the live-seeded
  chase+gmail stack at `97dc8b80`. Chase money cards now show correct cents
  amounts (e.g. Bluebird Bakery −$12.45, Acme Payroll $4,381.20).
- `sandbox-explore.png` — `/sandbox/explore` typed-card reference (mock data).
- `probe.json` — DOM probe output backing the tables above.

## What this does NOT prove (honest scope)

This is a **bounded** proof of money + message card *fidelity* (kind dispatch +
money-value formatting). It is NOT full designer parity. The designer artifact's
photo/activity/reader/location cards, the per-stream view switcher, and the
grant-projection / `redacted_reason` toggle remain a separate, larger tranche
(see the `add-explorer-live-presentation-types` `design.md`). ">95% live
fidelity" is claimed for money + message dispatch and money-amount formatting,
not for full designer parity.

Data is synthetic (real-shaped, no PII), seeded via the public ingest path — not
a live bank/email collection run. Intentional, per the lane brief.

## Reproduce

Identical to `10fb2f59`. From a deps-installed checkout at this commit (ports
7762/7763 + 3300/3301 avoid colliding with a default-port stack):

```bash
# 1. Seed + serve the isolated reference stack (registers the real chase+gmail
#    manifests, seeds synthetic records, self-verifies declared types surface):
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

The fast, browser-free regression guard for the same fix lives in the unit
suite — run it without a stack:

```bash
node --test apps/web/src/app/dashboard/lib/record-preview.test.ts \
            apps/web/src/app/dashboard/lib/timeline-summaries.test.ts
node --test apps/console/src/app/dashboard/lib/record-preview.test.ts \
            apps/console/src/app/dashboard/lib/timeline-summaries.test.ts
```

Those cover chase bare-amount cents, declared-type-over-magnitude, explicit
milliunits, and YNAB milliunit preservation — the exact cases this live capture
exercises end-to-end.
