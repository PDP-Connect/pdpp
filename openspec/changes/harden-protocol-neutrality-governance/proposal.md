## Why

PDPP's root protocol spec and public site should state the protocol's implementation-neutral posture directly. Current prose implies that posture through URI-based identifiers and grant-pinned manifests, but reviewers should not have to infer that PDPP conformance is independent of any specific hosted service, chain, token, registry, or vendor deployment.

The public site also contains stale `pdpp.vana.*` references and one CLI example that should use the current `pdpp.dev` and `pdpp` naming.

## What Changes

- Add protocol-neutrality and governance prose to `spec-core.md`.
- Add a Section Map for the major Core spec sections so readers can see which layer each section governs.
- Add a concise governance section describing public PR/OpenSpec workflow and active maintainer/editor records.
- Align software package metadata with Apache-2.0.
- Align public-site canonical URLs and example copy to `pdpp.dev` / `pdpp`.

## Capabilities

Modified:
- `reference-implementation-governance`

## Impact

- Root protocol prose becomes clearer for implementers and external reviewers.
- Site metadata and example copy stop pointing at stale `pdpp.vana.*` domains.
- Package metadata matches the repository's Apache-2.0 software-license posture.
- No protocol wire format, endpoint, schema, or reference runtime behavior changes.
