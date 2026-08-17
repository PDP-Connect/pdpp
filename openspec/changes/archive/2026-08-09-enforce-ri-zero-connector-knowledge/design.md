## Context

The RI is meant to be a forkable substrate whose behavior is driven entirely by the manifest schema and connector-authored facts (`reference-implementation-architecture` capability, "The reference implementation remains a forkable substrate"). In practice, connector identity has leaked into RI production code repeatedly: `server/connector-key.ts` and `server/connection-setup-plan.ts` hand-maintain multiple connector-name allowlists (both self-documented as deliberate "migration groundwork" from the prior `canonicalize-connector-keys` change), `runtime/scheduler-readiness.ts` branches on `codex`/`claude-code` literals, `runtime/connector-gap-bounding.ts` and `runtime/scheduler-source-pressure-cooldown.ts` hardcode connector-specific sets/dispatch inside generic policy modules, `server/provider-auth/google-*.ts` hardcode Google's live OAuth endpoints and env var names, `server/version-disposition.ts` hardcodes five connector+stream policy tables, and `scripts/compact-record-history.ts` hardcodes per-connector compaction policy throughout.

Nothing today proves the *absence* of this knowledge. `packages/polyfill-connectors/src/connector-conformance.test.ts` and its siblings prove connectors are honest about what they declare (manifest listing matches roster, schema coverage, etc.) but they run from inside the connector package and have no visibility into whether *RI* code independently hardcodes the same names. This change adds the missing direction: a guard that scans RI code for connector knowledge, not connector code for honesty.

## Goals / Non-Goals

**Goals:**
- State the invariant normatively in the durable architecture spec, not just as a proposal.
- Ship an executable guard that fails today, against the real current violations, with a precise file:line inventory — not a guard tuned to already pass.
- Make the guard's own "known connector identity" set manifest-derived, so the guard cannot itself become a second hardcoded connector list.
- Wire the guard into the existing local-signoff mechanism (`scripts/ci-mode.ts`) using the same trigger-on-changed-path-prefix pattern already used for `packages/polyfill-connectors/` and `reference-implementation/manifests/`, so it's reachable without inventing a new CI concept.
- Allow manifests, fixtures/tests, connector-owned code, and generic display-value tables that key off connector-authored data (not connector identity) to pass.

**Non-Goals:**
- Fixing the ~9 violating files in this change. Remediating `connector-key.ts`'s allowlist, `scheduler-readiness.ts`'s codex/claude-code branch, the Google-specific OAuth files, etc. is real, non-trivial follow-up work (some of it requires new manifest fields, e.g. a `required_local_paths` capability to replace the codex/claude-code branch) that belongs to the owning lanes, not to this spec/guard commit.
- Building a full TypeScript AST/type-checker-based scanner. A structural regex/text scanner over `.ts` source is enough to catch every violation shape found in the audit and is far cheaper to maintain; it trades a small amount of theoretical evadability for zero new toolchain dependency, matching the guard style already used by `stream-evidence-strategy-manifest.test.ts` and `coverage-policy-manifest-honesty.test.ts`.
- Re-litigating whether `display-messages.ts`'s end-user copy strings (which name providers like "ChatGPT", "H-E-B", "Reddit" in free-text English sentences) violate the invariant. That file's *mechanism* (a reason-code → copy lookup keyed by connector-emitted reason literals) is the sanctioned connector-authored-data pattern; its *string content* naming providers in prose is a separate, softer question deliberately left to future design discussion rather than folded into this guard's fail-closed literal/identifier detection.

## Decisions

**Structural scan, not full static analysis.** The guard treats each `.ts` file's source text as a sequence of statements and applies targeted patterns:
1. Manifest-derived connector-identity set — read every `connector_key`/`connector_id` (basename after the registry prefix) from both `reference-implementation/manifests/*.json` and `packages/polyfill-connectors/manifests/*.json` at scan time.
2. Flag any string-literal array/object-key/Set-member/switch-case/`===` comparison whose literal value matches a known connector key from (1), found in a file under the scanned production roots.
3. Flag any literal absolute URL (`https?://<host>`) whose host is not on a small generic/protocol allowlist (`registry.pdpp.org`, `localhost`, `127.0.0.1`, `pdpp.org`, IANA/W3C/JSON-Schema reference hosts, and RFC example/test hosts).
4. Flag any string literal matching `/^[A-Z][A-Z0-9_]*_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|API_KEY|ACCESS_TOKEN|PASSWORD)$/` whose prefix is not a generic `PDPP_`/`NODE_`/test-only token, since first-party generic config never needs a provider-shaped env var name.

Each pattern independently reports file:line:snippet; the test fails if the combined violation count is nonzero, printing the full inventory so a future remediation pass has a checklist.

**Scope boundary.** Scanned roots: every `.ts` file under `reference-implementation/` except `reference-implementation/connectors/`, `reference-implementation/test/`, anything named `*.test.ts`, and `reference-implementation/manifests/` (JSON, not scanned as TS anyway). `packages/polyfill-connectors/connectors/*` (connector-owned code) and `packages/polyfill-connectors/manifests/*` are out of scope entirely — they are read only to build the manifest-derived identity set in decision 1.

**No auto-fix, no suppression list seeded with today's violations.** A guard that ships with every current violation pre-allowlisted would pass immediately and prove nothing. The guard fails against `HEAD` by design; the inventory in `tasks.md` is the record of what must close before it goes green, expected to happen via separate follow-up lanes' eventual integration (per the task instructions, not weakened to make this isolated branch pass).

**Signoff wiring reuses the existing trigger, doesn't invent a new one.** `scripts/ci-mode.ts` already has `CONNECTOR_SURFACE_PATH_PREFIXES` gating the connector-conformance suite on changes to `packages/polyfill-connectors/` or `reference-implementation/manifests/`. This change adds a third trigger condition — a change touching `reference-implementation/` production code (outside `connectors/`/tests) — and runs the new guard test file under that same signoff step, alongside (not instead of) the existing connector-conformance run.

## Risks / Trade-offs

- **False positives on legitimate generic code.** A regex-based scanner can misfire on a connector-key-shaped string that's actually a test fixture or a coincidental match. Mitigated by scoping strictly to production non-test files and by deriving the connector-identity set from real manifests (so the match surface is exactly the real connector vocabulary, not a guess).
- **False negatives / evadability.** A determined author can still smuggle a connector-specific branch past a text scanner (e.g. via string concatenation or an indirect constant). This is accepted: the goal is to catch the actual violations found in the current audit and raise the cost of adding new ones, not to build an unforgeable oracle. `design.md`'s Non-Goals section states this trade explicitly.
- **The guard fails on land, by design.** Anyone running `pnpm --dir reference-implementation test` on `main` today will see this new failure. That is the intended state per the task: the guard proves the current violations exist; remediation is separate follow-up work, expected to close as other lanes' changes land.
