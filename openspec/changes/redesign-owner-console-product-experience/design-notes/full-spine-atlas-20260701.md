# Full Spine Evidence Atlas

Status: evidence atlas
Owner: RI owner
Created: 2026-07-01
Related: `redesign-owner-console-product-experience`

## Purpose

This atlas preserves desktop and mobile browser evidence for the owner-console
spine defined by this change:

- Know Data: Dashboard, Sources, and Syncs/Runs as the current inventory and
  activity surfaces.
- Add Data: the Add source catalog.
- Inspect Data: Explore as the cross-source record workbench.
- Recover Problems: Source detail with a local-collector recovery state.
- Grant/Connect AI Apps: Connect AI Apps and Grants.

It intentionally avoids live owner records, credentials, account labels, and
private host names. Pages that could otherwise expose live owner state use
deterministic dev-only fixtures behind `NODE_ENV !== "production"` and
`?demo=...` guards.

This is not a claim that the owner-console redesign is complete. It closes the
durable screenshot and browser-evidence atlas gap. The higher owner-return gate
still requires data-truth probes, owner-reviewed merge decisions, and
adversarial review before broad handoff.

## Capture Environment

- Console dev server: `http://127.0.0.1:3111`
- Command posture: `PDPP_OWNER_PASSWORD` unset so local-dev placeholder owner
  auth did not block seeded demo pages.
- Browser: installed `google-chrome` in headless CDP mode.
- Data: seeded or synthetic fictional fixtures only.
- Evidence format: each screenshot has a sibling `.evidence.json` file recording
  the URL, viewport, console events, and any network failure or HTTP-error events
  observed during capture. Successful requests are not enumerated.

## Evidence Files

Screenshots and evidence receipts live under
`full-spine-atlas-20260701/`.

| Journey | Route | Desktop | Mobile | Evidence receipts |
|---|---|---|---|---|
| Know Data / dashboard alarm | `/dashboard?demo=alarm` | `dashboard-alarm-desktop.png` | `dashboard-alarm-mobile.png` | `dashboard-alarm-*.evidence.json` |
| Know Data / source inventory | `/dashboard/records?demo=mixed` | `sources-mixed-desktop.png` | `sources-mixed-mobile.png` | `sources-mixed-*.evidence.json` |
| Know Data / sync activity | `/dashboard/runs?demo=1` | `syncs-runs-desktop.png` | `syncs-runs-mobile.png` | `syncs-runs-*.evidence.json` |
| Add Data | `/dashboard/records/add?demo=atlas` | `add-source-desktop.png` | `add-source-mobile.png` | `add-source-*.evidence.json` |
| Inspect Data | `/dashboard/explore?demo=atlas` | `explore-workbench-desktop.png` | `explore-workbench-mobile.png` | `explore-workbench-*.evidence.json` |
| Recover Problems | `/dashboard/records/atlas-recovery?demo=atlas` | `source-recovery-desktop.png` | `source-recovery-mobile.png` | `source-recovery-*.evidence.json` |
| Connect AI Apps | `/dashboard/connect?demo=atlas` | `connect-ai-apps-desktop.png` | `connect-ai-apps-mobile.png` | `connect-ai-apps-*.evidence.json` |
| Grants / access review | `/dashboard/grants?demo=atlas` | `grants-access-desktop.png` | `grants-access-mobile.png` | `grants-access-*.evidence.json` |

## Browser Evidence Summary

The 16 evidence receipts show:

- `consoleErrors`: 0
- `httpErrors`: 0
- `networkFailed`: 0
- dev-mode informational logs only, primarily React DevTools and HMR messages
- no captured network failure or HTTP-error events; successful requests are not
  logged in the receipts

This is browser evidence for render safety, not a data-truth probe. Count,
freshness, and coverage truth still require the existing server-side probes and
owner-spine gates.

## Fixture Hygiene

The atlas added dev-only fixtures for surfaces that cannot safely rely on live
owner state:

- Add source catalog archetypes: static credential, manual upload, local
  collector enrollment, deployment-blocked provider auth, and proof-gated
  browser-bound setup.
- Explore record workbench: source facets, warning copy, selected record detail,
  upcoming event, and full-set stream escape links.
- Source recovery: local-collector dead-letter recovery with one human cause,
  one recovery action, stream facts, and diagnostics.
- Grants/access: pending approval, active grant, and revoked grant without live
  client or source identifiers.
- Connect AI Apps: fictional local client metadata and loopback redirect.

All fixture branches are guarded by `NODE_ENV !== "production"` and an explicit
`?demo=atlas` or seeded demo flag. They are screenshot fixtures, not production
data paths.

## Atlas-Found Fixes

The atlas found and fixed two owner-facing defects while capturing the evidence:

- Explore full-set escape links could concatenate when multiple stream links
  rendered together. `.rr-x-see-all-links` and `.rr-x-see-all` now wrap and space
  those links.
- Grants source captions exposed technical connector prefixes for connector
  sources. Connector-backed source captions now render as owner labels such as
  `source ChatGPT` rather than `source connector:ChatGPT`.

## Residuals

This atlas does not close:

- Tasks 2.5 and 2.6. Runs/Syncs and Explore/stream merge decisions still need
  owner-reviewed mocks.
- The 0.x owner-return gate. This atlas is an internal checkpoint, not final
  completion.
- Data-truth probes for every count, status, freshness, and coverage fact shown
  in live owner data.
- The global per-tranche review discipline for future substantive work.

The adversarial review for this atlas tranche is retained separately in
`full-spine-atlas-review-20260701.md`; it returned LAND with the residuals above.
