# Initial Live Atlas Pass

Date: 2026-06-18
Status: Partial evidence, not a complete atlas
Environment: `https://pdpp.vivid.fish`, desktop viewport 1280x900
Mode: Read-only Playwright MCP navigation

## Purpose

This pass proves the browser evidence loop works in Codex-only mode and captures a first desktop baseline for the core owner routes. It does not complete the Wave 0 atlas because:

- mobile captures were not taken in this pass
- screenshots were saved as Playwright MCP artifacts, not tracked repo files
- route-specific data-truth probes were not run
- subject-specific click-throughs, setup submissions, recovery actions, and grant actions were not exercised

## Routes Captured

| Journey | Route | Screenshot artifact | Snapshot artifact | Console check |
|---|---|---|---|---|
| OJ1 overview | `/dashboard` | `owner-atlas-dashboard-desktop-20260618.png` | `owner-atlas-dashboard-desktop-20260618.md` | current-page check not rerun after later routes |
| OJ1 sources | `/dashboard/records` | `owner-atlas-sources-desktop-20260618.png` | `owner-atlas-sources-desktop-20260618.md` | captured to MCP artifact |
| OJ2 add data | `/dashboard/records/add` | `owner-atlas-add-data-desktop-20260618.png` | `owner-atlas-add-data-desktop-20260618.md` | captured to MCP artifact |
| OJ3 explore | `/dashboard/explore` | `owner-atlas-explore-desktop-20260618.png` | `owner-atlas-explore-desktop-20260618.md` | captured to MCP artifact |
| OJ6 syncs/runs | `/dashboard/runs` | `owner-atlas-runs-desktop-20260618.png` | `owner-atlas-runs-desktop-20260618.md` | captured to MCP artifact |
| OJ5 grants | `/dashboard/grants` | `owner-atlas-grants-desktop-20260618.png` | `owner-atlas-grants-desktop-20260618.md` | captured to MCP artifact |
| OJ5 connect AI apps | `/dashboard/connect` | `owner-atlas-connect-desktop-20260618.png` | `owner-atlas-connect-desktop-20260618.md` | captured to MCP artifact |
| Fresh-owner readiness | `/dashboard/deployment` | `owner-atlas-deployment-desktop-20260618.png` | `owner-atlas-deployment-desktop-20260618.md` | current-page warnings/errors: 0 |

## Console Evidence

`browser_console_messages(level="warning", all=false)` on the final loaded page returned:

- Errors: 0
- Warnings: 0

`all=true` returned older 502/404 messages from earlier browsing in the same browser session. Those are not accepted as current-route failures until reproduced route-by-route with fresh per-route console capture.

## Findings

- The Playwright MCP is usable from Codex for read-only live route navigation.
- A desktop atlas can be generated without Claude assistance.
- The next atlas pass must store screenshots in a tracked location or record enough reproducible MCP artifact metadata to keep the evidence durable.

## Next Acceptance Work

- Repeat core routes at mobile width.
- Capture route-specific console messages immediately after each route load in a fresh tab/session.
- Add data-truth probes for counts, statuses, grants, and record windows shown in each screenshot.
- Exercise at least one subject-preserving click-through per journey:
  - source row to source detail
  - source/stream to Explore
  - Add Data to setup/status without submitting secrets
  - grant package to child grant/read history
  - dashboard attention to recovery panel
- Store the final atlas under `docs/research/` or this change's `design-notes/` with stable screenshot paths.
