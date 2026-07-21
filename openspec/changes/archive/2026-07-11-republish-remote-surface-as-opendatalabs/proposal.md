## Why

`@pdpp/remote-surface` is the extracted streaming and control substrate (geometry, pointer mapping, mobile IME, clipboard policy, n.eko/CDP adapters, diagnostics, leases, testing fixtures). It is reusable infrastructure for any remote-browser surface, and PDPP is one consumer among many we expect.

The package name and license posture currently advertise the wrong story. `@pdpp/remote-surface` reads as a PDPP-internal artifact rather than the substrate it actually is, and the package still ships ISC with no `LICENSE` file. `make-remote-surface-oss-publishable` froze the package-shape work but deliberately deferred (a) the public identity question, (b) the license decision, and (c) the rule that PDPP/reference-only concepts (`_ref`, `run_id`, `interaction_id`) must not appear in the default public surface.

The owner has now made the directional calls: republish as `@opendatalabs/remote-surface`, keep developing inside the PDPP monorepo, default exports stay host-neutral, and PDPP-shaped APIs move behind a `/reference` subpath. License direction is Apache-2.0 for code and reference implementations, CC-BY-4.0 for documentation, with Community-Spec-1.0 reserved for any future formal-spec artifacts.

This change captures that decision as durable spec deltas, sequencing constraints, and an explicit list of owner-only follow-ups so worker lanes can act without re-litigating identity.

## What Changes

- Rename the published package identity from `@pdpp/remote-surface` to `@opendatalabs/remote-surface`, declared in `package.json`, README, `exports`, validator scripts, internal imports, and tarball validators.
- Treat the existing `@pdpp/remote-surface` name as an internal workspace alias only; it MUST NOT survive into the published tarball under that name.
- Default `exports` (`.`, `./adapters`, `./backends/*`, `./client`, `./controllers`, `./diagnostics`, `./ime`, `./leases`, `./protocol`, `./server`, `./testing`) SHALL be free of PDPP/reference-only concepts (`_ref`, `run_id`, `interaction_id`); reference-compatibility surfaces SHALL move under a dedicated `./reference` subpath.
- Follow-on standalone cleanup SHALL move generic session and lease cores out of `src/reference/`, move PDPP wire parsers/builders/fixtures under `src/compat/pdpp-reference/`, and keep `./reference` as a deprecated compatibility alias for one release.
- Update `scripts/validate-package.mjs` to limit the reference-token allowlist to `dist/reference/**`, not the cross-cutting `server/`, `protocol/`, `leases/`, `testing/` allowance in force today.
- Declare license posture: `LICENSE` files (Apache-2.0) for package code and for the reference implementation, `LICENSE-docs` (CC-BY-4.0) for documentation; Community-Spec-1.0 is RESERVED for future formal-spec artifacts and is out of scope for this change.
- Capture publish-readiness metadata gates (`repository`, `bugs`, `homepage`, `keywords`, `publishConfig.access`, `engines.node`, optional `publishConfig.provenance`) and record the owner-confirmed values: public repo `https://github.com/vana-com/remote-surface`, security contact `security@vana.org`, and supported runtime `engines.node: ">=24"` (the 2026 Active LTS line for this new package).
- Treat the deprecation horizon for the legacy `./server` re-exports of `./reference` symbols as a release-management decision that MAY be finalized after this change is accepted but MUST be answered before the first public npm publish; it is explicitly non-blocking for accepting this change or running the worker lanes that perform the rename, the subpath split, and the metadata fill-in.
- Treat the final `LICENSE` copyright line as deferred while the package remains `private: true` and internal; the worker lane that adds `LICENSE` MAY land Apache-2.0 boilerplate with a placeholder copyright holder. An explicit, owner-accepted copyright line MUST be in place before the package is flipped to `private: false` and published to npm.
- Do not rename or publish anything in this change; sibling worker lanes implement the rename only after this change is accepted and `standardize-pdpp-package-publishing` policy hook is in place.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: add OpenDataLabs publication identity, reference-subpath isolation, license posture, and publish-readiness metadata requirements for the remote-surface package.

## Impact

- Affects `packages/remote-surface/package.json`, `packages/remote-surface/README.md`, `packages/remote-surface/src/**`, `packages/remote-surface/scripts/validate-package.mjs`, and any in-repo importers of `@pdpp/remote-surface`.
- This follow-on tranche is strictly behavior-preserving: it moves source ownership and export presentation only, with existing `./reference` imports preserved by re-export aliases.
- Affects `scripts/check-package-release-policy.mjs` (must accept the renamed package).
- Co-sequenced with `make-remote-surface-oss-publishable` (which assumed the `@pdpp/remote-surface` name) and with `standardize-pdpp-package-publishing` (release-policy gates).
- Does not change runtime semantics, wire format, or protocol; consumers inside the monorepo see only a name and subpath shift.
- Owner has answered the publish-readiness inputs that gate worker lanes: public repo `https://github.com/vana-com/remote-surface`, security disclosure contact `security@vana.org`, supported runtime `engines.node: ">=24"`. The deprecation horizon for legacy `./server` re-exports and the final `LICENSE` copyright line are deferred as release-management decisions that MUST be answered before the public npm publish but are explicitly non-blocking for this change.
