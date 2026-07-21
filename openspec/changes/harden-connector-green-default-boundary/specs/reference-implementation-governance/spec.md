## ADDED Requirements

### Requirement: The local signoff gate SHALL run the connector-conformance suite when the connector surface or the gate itself changes

`scripts/ci-mode.mjs signoff` (invoked as `pnpm ci:signoff`) SHALL run the connector-conformance test files (`stream-evidence-strategy-manifest.test.ts`, `coverage-policy-manifest-honesty.test.ts`, `connector-conformance.test.ts` under `packages/polyfill-connectors/src/`) before posting a success commit status, whenever the diff between `HEAD` and `--base` (default `origin/main`) touches `packages/polyfill-connectors/`, `reference-implementation/manifests/`, OR the gate's own implementation (`scripts/ci-mode.mjs`, `scripts/ci-mode.test.mjs`, `package.json`, or the connector-conformance test files themselves). This closes the gap left by `.github/workflows/polyfill-connectors.yml` being explicitly non-blocking: those tests already catch a scaffolded or dishonest connector manifest, but ran on no gate that actually blocks merge under local CI mode. The strategy-declaration test reads both manifest roots, so reference-manifest-only changes must trigger it too. Including the gate's own implementation in the trigger surface prevents a change to the gate from skipping the exact suite it exists to enforce.

There SHALL be no bypass flag. If the diff between `HEAD` and `--base` cannot be computed (missing base ref, shallow clone), `signoff` SHALL fail outright rather than treat the gate as not required.

#### Scenario: A PR changes a connector manifest under local CI mode

**WHEN** a contributor runs `pnpm ci:signoff` and the diff against `origin/main` includes a file under `packages/polyfill-connectors/` or `reference-implementation/manifests/`
**THEN** `signoff` SHALL run the connector-conformance test files
**AND** SHALL NOT post a success status if any of them fail

#### Scenario: A PR changes only the gate's own implementation

**WHEN** the diff against `--base` includes `scripts/ci-mode.mjs` (or `scripts/ci-mode.test.mjs`, `package.json`, or a connector-conformance test file) but no path under `packages/polyfill-connectors/` otherwise
**THEN** `signoff` SHALL still run the connector-conformance test files
**AND** SHALL NOT post a success status if any of them fail

#### Scenario: A PR does not touch the connector package or the gate

**WHEN** the diff against `--base` includes no path under `packages/polyfill-connectors/` or `reference-implementation/manifests/` and does not touch the gate's own implementation
**THEN** `signoff` SHALL post its success status without running the connector-conformance suite

#### Scenario: The diff against base cannot be computed

**WHEN** `git merge-base`/`git diff` against `--base` fails (missing ref, shallow clone)
**THEN** `signoff` SHALL fail closed and SHALL NOT post any status

### Requirement: The local signoff gate SHALL verify source-derived stream-evidence inventory whenever its inputs change

`scripts/ci-mode.mjs signoff` SHALL run `scripts/stream-evidence-inventory.mjs --check` before posting a success status whenever the diff between `HEAD` and `--base` touches either shipped manifest root (`packages/polyfill-connectors/` or `reference-implementation/manifests/`), the inventory producer (`scripts/stream-evidence-inventory.mjs`), or its generated artifact (`docs/reference/stream-evidence-inventory.md`). This keeps the local required status at least as strict as the hosted reference gate for source-derived evidence: the inventory's rendered requiredness, coverage/freshness strategies, and accepted-absence contradictions must agree with the committed artifact.

Changed paths SHALL be obtained from `git diff --no-renames --name-only -z` and parsed as NUL-delimited UTF-8 path names. The implementation SHALL NOT parse Git's display-oriented newline-delimited/quoted path output, because a valid repository path may contain Unicode or an embedded newline. Rename detection SHALL remain disabled for this gate so a manifest moved from a protected root to an unprotected destination is represented as the protected deletion plus the unprotected addition; the move SHALL therefore trigger both evidence gates.

#### Scenario: A reference-only requiredness edit leaves the inventory stale

**WHEN** a contributor changes `required` in a manifest under `reference-implementation/manifests/` without regenerating `docs/reference/stream-evidence-inventory.md`
**THEN** `signoff` SHALL fail the inventory check
**AND** SHALL NOT post a success status

#### Scenario: Inventory producer or generated artifact changes

**WHEN** the diff changes `scripts/stream-evidence-inventory.mjs` or `docs/reference/stream-evidence-inventory.md`
**THEN** `signoff` SHALL run the inventory check before posting success

#### Scenario: A protected manifest path contains Unicode or a newline

**WHEN** the diff contains a path below either shipped manifest root whose filename contains Unicode or an embedded newline
**THEN** `signoff` SHALL still recognize the protected root and run the corresponding connector and inventory gates

#### Scenario: A manifest moves out of a protected root

**WHEN** a manifest moves from either shipped manifest root to a path outside both roots without regenerating the inventory
**THEN** `signoff` SHALL recognize the protected deletion, fail the inventory check, and SHALL NOT post success

### Requirement: The local signoff gate SHALL always test the exact commit it signs

`signoff` SHALL refuse to post a status when the local worktree has uncommitted or unpushed changes. There SHALL be no dirty-worktree override flag. If `--sha` is provided, it SHALL equal the current `HEAD`; a mismatched `--sha` SHALL fail `signoff` rather than post a status for a commit whose code was not the code just tested.

#### Scenario: Worktree has uncommitted changes

**WHEN** `pnpm ci:signoff` runs against a worktree with uncommitted or unpushed changes
**THEN** `signoff` SHALL fail and SHALL NOT post any status

#### Scenario: --sha does not match HEAD

**WHEN** `pnpm ci:signoff -- --sha <sha>` is invoked with a `<sha>` different from the current `HEAD`
**THEN** `signoff` SHALL fail with an error naming both SHAs and SHALL NOT post any status

### Requirement: The local signoff gate SHALL exercise itself when its own implementation changes

When the diff against `--base` touches the gate's own implementation (`scripts/ci-mode.mjs`, `scripts/ci-mode.test.mjs`, `package.json`, `packages/polyfill-connectors/src/stream-evidence-strategy-manifest.test.ts`, `packages/polyfill-connectors/src/coverage-policy-manifest-honesty.test.ts`, or `packages/polyfill-connectors/src/connector-conformance.test.ts`), `signoff` SHALL run BOTH `ci:mode:test` AND the connector-conformance test files (per the preceding requirement) before posting a success status — not one in place of the other. A change that weakens or breaks the gate cannot sign itself off without first exercising both its own unit tests and the conformance suite it wraps.

#### Scenario: A PR edits scripts/ci-mode.mjs

**WHEN** the diff against `--base` includes `scripts/ci-mode.mjs`
**THEN** `signoff` SHALL run `ci:mode:test`
**AND** SHALL also run the connector-conformance test files
**AND** SHALL NOT post a success status if either fails
