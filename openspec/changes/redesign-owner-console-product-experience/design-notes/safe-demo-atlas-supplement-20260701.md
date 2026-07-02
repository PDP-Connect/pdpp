# Safe Demo Atlas Supplement

Status: partial evidence
Owner: RI owner
Created: 2026-07-01
Related: `redesign-owner-console-product-experience`

## Purpose

This supplement preserves safe, deterministic screenshot evidence for the
owner-console surfaces that already expose seeded demo states. It does not use
live owner records, credentials, or account labels.

This is not the full owner-spine atlas. It proves that the seeded capture path
works for Dashboard, Sources, and Syncs/Runs, and it records the remaining
coverage gap for Add Data, Explore, Recovery, Grants/Connect AI Apps, and fresh
owner onboarding.

## Capture Environment

- Console dev server: `http://localhost:3111`
- Command posture: `PDPP_OWNER_PASSWORD` explicitly unset so local-dev
  placeholder owner auth did not block seeded demo pages.
- Browser: installed `google-chrome` in headless mode.
- Data: fictional seeded demo fixtures only.

Server command:

```bash
env -u PDPP_OWNER_PASSWORD PDPP_WEB_PORT=3111 pnpm --dir apps/console run dev
```

Capture command shape:

```bash
google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=<width,height> \
  --screenshot=<output.png> \
  "http://localhost:3111/<route>?demo=<scenario>"
```

## Evidence Files

Screenshots live under `safe-demo-atlas-20260701/`.

| File | Viewport | Route | What it proves |
|---|---:|---|---|
| `dashboard-alarm-desktop.png` | 1280x900 | `/dashboard?demo=alarm` | Desktop Dashboard can show one owner-action hero, owner-token rows, and seeded notice without live data. |
| `dashboard-alarm-mobile.png` | 390x844 | `/dashboard?demo=alarm` | Mobile Dashboard preserves the same owner-action hierarchy. |
| `sources-mixed-desktop.png` | 1280x900 | `/dashboard/records?demo=mixed` | Desktop Sources seeded view renders source inventory, detail/passport, stream table, and basis-oriented status copy. |
| `sources-attention-mobile.png` | 390x844 | `/dashboard/records?demo=attention` | Mobile Sources seeded view renders the responsive source list and attention state. |
| `runs-demo-desktop.png` | 1280x900 | `/dashboard/runs?demo=1` | Desktop Syncs/Runs seeded view renders schedule summary, owner-action card, and non-owner-action review card. |
| `runs-demo-mobile.png` | 390x844 | `/dashboard/runs?demo=1` | Mobile Syncs/Runs preserves the owner-action versus review distinction. |

## Fixture Hygiene

During capture, the Dashboard alarm fixture still used a private host-style
label. The fixture was changed to the role-neutral label `Claude Code on
workstation` before retaining screenshots.

The remaining visible ids and account names in these screenshots are seeded
fictional values from the demo fixtures.

## Coverage Status

This supplement supports, but does not close, the screenshot atlas tasks.

It covers:

- Desktop and mobile pixels for Dashboard, Sources, and Syncs/Runs demo states.
- Safe synthetic evidence for owner-action, review/no-action, source inventory,
  stream table, and responsive layout states.

It does not cover:

- Add Data setup/status.
- Explore record workbench interactions.
- Source recovery progress and terminal reconciliation.
- Grants, grant package detail, read history, and Connect AI Apps.
- Fresh-owner onboarding.
- Route-specific browser console and network receipts saved as tracked files.
- Data-truth probes for every visible count/status in the screenshots.

Therefore tasks 3.2, 3.3, 3.4, 3.5, and 3.6 remain open until the missing
journeys have durable screenshots, browser evidence, and data-truth probes, or
are explicitly listed as residual blockers under the 0.x owner-spine gate.
