# Design

## Target

The owner console is a reference-instance owner cockpit, not a generic connector catalog. Its first-order promise is that the owner can understand collected data, add more sources, recover problems, and grant access without contradictory status, false primary actions, or implementation jargon.

The dominant object is the configured data source or connection: a specific account, workspace, device, browser session, API credential, or imported artifact that contributes records. Runs, traces, schedules, and diagnostics are evidence layers. They must support source recovery, not become the normal recovery destination.

## Problem Diagnosis

The failed journey batch had a process root cause:

- the owner gave broad evidence that the product was not shippable; workers were given narrow labels-as-fixes tasks.
- Acceptance collapsed to local proxies: no dead-end labels, mocked fetch tests, and source scans.
- Component ownership split from journey ownership. Add-source, browser-session, sources list, and recovery could each look locally improved while the cross-route owner path got worse.
- The shipped review object was code and isolated route output, not a confused-owner walkthrough with real pixels, live data, console errors, failed network requests, and a single pass/fail verdict.

The correction is an execution spine: define the owner promise, map every UI tranche to a journey acceptance row, and verify shipped pixels before deploy.

## Journey Model

Core journeys:

- **J1: Know what data I have.** The source list and detail page identify concrete configured sources and show useful stream/record/freshness facts or honest unknowns.
- **J2: Add more data.** The add-source surface distinguishes sources that can be added now from sources that require server/operator setup or are unavailable from the page. It never turns a developer portal, missing proof path, or future connector into a primary setup action.
- **J3: Know what is broken.** Dashboard hero, Runs, Sources list, source detail, and recovery panels derive attention from one rendered-verdict contract. They do not disagree about what needs owner action.
- **J4: Know what to do next.** Recovery CTAs land on the exact source and one cause-specific next step. Device-local actions navigate to instructions; they are not rendered as remote buttons.
- **J5: Trust this system.** Unknown is checking/grey, unavailable is honest, row geometry is stable across states, browser setup failures are inline and recoverable, and copy does not expose operator internals to normal owners.

## State Archetypes

Use representative archetypes rather than pretending to cover every connector/state permutation:

- Healthy scheduled API source.
- Static-secret setup source.
- Browser-session setup source.
- Local collector/device source.
- Manual artifact import source.
- Unsupported or unavailable source.
- Revoked source with retained records.
- Running source/import.
- Degraded self-healing source.
- Degraded owner-action source.
- Maintainer/code issue.
- Unknown/checking source.

Every journey change must state which archetype it closes.

## Execution Rules

Workers may be used aggressively, but only in bounded roles:

- Evidence lanes: screenshot, inspect, audit, compare prior art, or identify root cause.
- Implementation lanes: build one owner-authored acceptance packet with exact files/scope.
- Review lanes: adversarially evaluate a diff or journey artifact.

Workers do not decide what ships, broaden scope, or redefine a complaint into an easier local proxy. The RI owner owns the acceptance ledger, integration, and live deploy gate.

## Acceptance Evidence

For owner-console UI changes, green unit tests are not enough. A deployable tranche needs:

- Before/after screenshot or headed-browser capture for affected routes.
- Real headed journey proof for at least one canonical positive case or a documented reason it cannot be exercised without the owner.
- Browser console and failed-network capture for routes touched by client navigation or browser setup.
- No false-action/jargon scanner regression.
- Typecheck and relevant tests.
- Live-stack mutex declaration before deploy/restart/container mutation, then closeout with smoke evidence.

## Current Priority Queue

1. Browser-session setup: remove owner-facing operator dead ends and replace server-action start transport with a normal POST redirect route; prove Amazon Start Session no longer crashes into the dashboard error boundary.
2. Add-source honesty: primary flow only contains real setup/import actions; unavailable paths are hidden or clearly separated with owner-meaningful labels.
3. Sources cockpit: fix layout squish, state-dependent geometry, selected-row highlight collision, and empty stream facts.
4. Attention/recovery consistency: preserve the recovered single-attention truth and cause-specific remediation while routing every summary to exact source recovery.
5. Pixel/craft pass only after the trust/task blockers above are closed.

## Non-Goals

- This change does not make every connector support one-click setup.
- This change does not redefine PDPP protocol semantics.
- This change does not promise external-user delight without external testing.
- This change does not authorize broad navigation redesign unrelated to a ledger row.
