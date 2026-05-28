## Why

A friend or r/selfhosted reader cannot reliably stand up their own PDPP reference deployment, connect data sources, and permission Claude or ChatGPT today. The Docker image, compose file, owner gate, and hosted MCP grant package flow all exist, but there is no operator-facing onboarding lane that names the substrate constraints (RunPod especially), states the minimum-boot env vars, and surfaces first-run misconfigurations in the dashboard. The result is silent failure modes: dashboards reachable with no owner password, reference-origin mismatches behind a proxy, embedding cache still downloading, or an out-of-date image whose `/mcp` does not advertise `refresh_token`.

PDPP is not a hosted service. The fix is a self-host onboarding SLVP that respects that framing.

## What Changes

- Add a self-host quick-start runbook with two named substrate lanes (`Docker host` and `RunPod Pod (CPU)`), each with minimum env vars, dashboard verification, MCP wiring, update path, and backup pointer.
- Add a deployment readiness panel on `/dashboard/deployment` that surfaces structured first-run self-check rows (owner-password posture, reference-origin/proxy alignment, storage health, embedding cache state, MCP refresh-token advertisement) with one-line remediation per row.
- Add a documented "what RunPod gives you and what it does not" section that scopes the SLVP honestly (no native multi-container compose, no first-party custom TLS, no UDP, single Pod).
- Document the deferred next slices (RunPod Hub `hub.json` + `tests.json` template, in-dashboard credential UI) without implementing them.

## Capabilities

### Modified

- `reference-implementation-architecture`: the reference implementation SHALL ship operator-facing self-host onboarding artifacts and a deployment readiness self-check that surfaces existing diagnostic state.

## Impact

- Docs: new `docs/operator/selfhost-quickstart.md`; the existing `docs/operator/hosted-mcp-setup.md` becomes the second hop from the quick-start.
- Dashboard: new readiness panel on `/dashboard/deployment` reading from `/_ref/deployment` plus a small client-side check comparing `window.location.origin` to `PDPP_REFERENCE_ORIGIN`. No new control plane.
- Protocol/Core: untouched. No grant, manifest, or wire-format change.
- Security: the readiness panel makes the owner-password-unset case visible to the operator viewing the dashboard. This is honest surfacing of an existing state, not a new posture.
- Voice/framing: the quick-start follows `docs/voice-and-framing.md` rules. PDPP-as-protocol leads; RunPod and Docker host are downstream substrates; the operator is addressed as the operator of their own instance, not "the user of a service."
