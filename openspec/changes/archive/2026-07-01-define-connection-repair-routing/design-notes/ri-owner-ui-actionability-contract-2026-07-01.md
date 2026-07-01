# RI owner UI actionability contract

Date: 2026-07-01
Status: captured for `define-connection-repair-routing`

## Decision

The RI owner UI SHALL NOT consume raw connector manifests as the source of current repair/actionability truth. Raw manifests are setup and capability inputs. The server-owned connection projection is the UI contract.

The live UI stack should be:

1. Manifest declares stable setup/runtime/scheduling mechanisms.
2. Runtime/controller records current evidence: credential state, session readiness, run assistance, coverage, local outbox, remote surface, schedule/backoff.
3. Server synthesizes `connection_health` and `rendered_verdict.required_actions[]`.
4. Console/CLI/owner-agent consume the same actionability projection over `rendered_verdict`.

## UI Consumption Rule

Owner-facing RI surfaces MAY use manifest data for:

- Add source/setup catalog;
- setup form shape;
- deployment prerequisites;
- static labels for connector identity and stream catalogue;
- scheduling policy labels when they are not presented as live health.

Owner-facing RI surfaces SHALL use `rendered_verdict`, `connection_health`, and required-action satisfaction contracts for:

- whether the owner must act now;
- whether an item belongs under owner action, review, system/connector issue, or checking;
- which CTA to show;
- when repair is satisfied;
- when a failed/partial run is recoverable, owner-actionable, transient, or connector-broken.

## Surface Contract

- Overview uses `sourceWorkFromConnectors(connectors)` for Source attention sections and hero escalation.
- Sources uses `projectSourceActionability(summary)` for list status, review cues, stream owner-action availability, and primary source actions.
- Runs/Syncs uses `projectSourceActionability(connector)` for failure cards and top-band counts.
- Connection detail uses the same `projectSourceActionability(summary)` and may show deeper diagnostics, but it SHALL NOT create an alternate actionability taxonomy.
- CLI and owner-agent setup may use the shared setup planner; repair/actionability should follow the same required-action semantics when exposed.

## Non-Goals

- Do not make manifests describe provider-specific auth pages.
- Do not create ChatGPT-specific owner-action UI.
- Do not infer owner actionability from connector id, provider name, progress copy, or raw error strings when `rendered_verdict` is present.
- Do not hide unresolved repair because an old prompt expired. Expiry removes the old prompt; it does not prove the connection healthy.

## Confidence

This contract is >95% confidence for the RI UI architecture because it matches the existing strongest code seams (`rendered_verdict`, `satisfied_when`, `source-actionability.ts`), mature connection-repair prior art, and the refresh boundary between PDPP Core, Collection Profile, and reference implementation. Exact visual treatment remains a product-design layer on top of this contract.
