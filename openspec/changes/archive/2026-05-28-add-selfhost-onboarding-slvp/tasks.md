# Tasks

## 1. Self-host quick-start doc

- [x] 1.1 Write `docs/operator/selfhost-quickstart.md` with Lane A (Docker host) and Lane B (RunPod CPU Pod) sections, voice-and-framing compliant.
- [x] 1.2 Cross-link from `reference-implementation/README.md` (deployment topology section) and from `docs/operator/hosted-mcp-setup.md` (back-link).
- [x] 1.3 Confirm every file path the quick-start cites (`docker-compose.yml`, `.env.docker.example`, `docs/operator/hosted-mcp-setup.md`) resolves.

## 2. Deployment readiness panel

- [x] 2.1 Add a `DeploymentReadinessPanel` view on `/dashboard/deployment` that consumes the existing `/_ref/deployment` response and the in-browser origin.
- [x] 2.2 Implement the five SLVP rows: owner-password gate, reference-origin alignment, storage backend, embedding cache, MCP refresh-token advertisement.
- [x] 2.3 Each row carries `{ check, status, detail, hint }` with `status ∈ { ok, warn, error, info, unknown }`. Hints are the exact strings from `design.md`. `unknown` is added for "browser-side probe not yet returned" so the panel never lies about a check it has not actually performed.
- [x] 2.4 Render the panel above existing diagnostic widgets so it is the first thing a first-boot operator sees (via the new `beforeDiagnostics` slot on `DeploymentDiagnosticsView`).
- [x] 2.5 No new `/_ref/*` endpoint; no new owner control plane mutation. The five rows derive entirely from the existing `/_ref/deployment` payload and two browser-side reads (`window.location.origin`, one-shot `/.well-known/oauth-authorization-server` fetch).

## 3. Defer trackers

- [x] 3.1 Add a `## Deferred` section in the quick-start linking to this change's `design.md#non-goals` and naming the next slices (RunPod Hub template, in-dashboard credential UI) so a future reader does not re-derive that they are out of scope.

## 4. Validation

- [x] 4.1 `openspec validate add-selfhost-onboarding-slvp --strict` passes.
- [x] 4.2 `openspec validate --all --strict` passes.
- [x] 4.3 Unit-tested: `ownerPasswordRow({ ownerPasswordProvenance: "absent", ... })` returns `status: "error"` with the documented hint (`deployment-readiness-rows.test.ts`).
- [x] 4.4 Unit-tested: `referenceOriginRow({ referenceOriginConfigured: "https://example.com" }, "https://other.example.com")` returns `status: "warn"` with the documented hint (`deployment-readiness-rows.test.ts`).
- [x] 4.5 Owner-only live verification (no-password row renders as `error` on first boot) recorded as a residual risk; see Residual Risks below. The row-derivation logic is locked in by `deployment-readiness-rows.test.ts` (`ownerPasswordRow` returns `status: "error"` whenever `ownerPasswordProvenance === "absent"`), so the only remaining check is that the panel renders the row at the documented position in a real browser.
- [x] 4.6 Owner-only live verification (origin mismatch row renders as `warn` in a browser) recorded as a residual risk; see Residual Risks below. The row-derivation logic is locked in by `referenceOriginRow` returning `status: "warn"` on origin mismatch. The remaining check is the in-browser render path against the live `/_ref/deployment` payload.

## 5. Secret-generation helper

- [x] 5.1 Add `scripts/generate-secrets.sh` that generates `PDPP_OWNER_PASSWORD` and the VAPID key pair, prints to stdout by default, and patches `.env.docker` in place only when `--write` is passed. Existing non-empty values are never overwritten.
- [x] 5.2 Update `docs/operator/selfhost-quickstart.md` Lane A to add step 2 (`bash scripts/generate-secrets.sh --write`) and step 3 (set `PDPP_REFERENCE_ORIGIN` manually). Renumber subsequent steps.
- [x] 5.3 Update `docs/operator/selfhost-quickstart.md` Lane B step 2 to use `bash scripts/generate-secrets.sh --write` instead of manual `sed` for the password.

## Acceptance checks

```sh
openspec validate add-selfhost-onboarding-slvp --strict
openspec validate --all --strict
```

Documentation:
- `docs/operator/selfhost-quickstart.md` exists, links resolve, voice-and-framing compliant.

Dashboard:
- `/dashboard/deployment` shows the readiness panel with the five rows above, rendered above the existing diagnostics widgets.
- Pure row-derivation logic is unit-tested via `apps/console/src/app/dashboard/components/deployment-readiness-rows.test.ts` (23 tests, `node --test`).

## Residual Risks

- Lane B (RunPod CPU Pod) is documented but not end-to-end verified on a fresh RunPod account in this change. Owner-only live verification.
- Owner-only live verification of the deployment-readiness panel's first-boot states (`PDPP_OWNER_PASSWORD` absent and `PDPP_REFERENCE_ORIGIN` mismatch) has not been performed in a real browser against a fresh container. The pure row-derivation functions (`ownerPasswordRow`, `referenceOriginRow`) are unit-tested in `deployment-readiness-rows.test.ts` and the panel mounts above the existing diagnostics widgets via the documented `beforeDiagnostics` slot, but only an owner running `docker compose up` against the current image can confirm the in-browser render path. Reproducible smoke commands for this owner-only check land in `tmp/workstreams/ri-closeout-product-ux-report.md`.
- MCP refresh-token check may report `warn` on deployments with non-co-located `AS_ISSUER`; hint mentions this.
