# Design

## Decision

The reference Docker n.eko overlay includes a small nginx service that serves
the repository's bundled connector manifest JSON files at
`http://registry.pdpp.org/connectors/<connector>` on the compose network. The
service has a network alias for `registry.pdpp.org`, so Node's regular fetch
path can resolve the same manifest URLs used as connector identifiers.

This is intentionally a reference-runtime convenience, not a protocol claim
that connector identifiers must be dereferenceable in every PDPP deployment.

## Why This Shape

- It preserves the current canonical connector IDs in the tracked manifests.
- It removes dependence on dirty local compose state.
- It keeps the reference runtime using the same manifest-fetching path it uses
  outside Docker, so connector validation behavior stays honest.
- It avoids folding the broader `pdpp.org` to `pdpp.dev` rename into this
  cleanup tranche.

## Alternatives

- Public static registry: correct long-term if connector IDs are meant to be
  public URLs, but it is deployment work and not required to make local Docker
  reproducible.
- Bake an internal map into the reference server: reduces Docker services, but
  creates a separate manifest resolution path that can drift from runtime fetch
  validation.
- Treat connector IDs as opaque and store manifests at registration: likely
  stronger long-term architecture, but it changes connector registration and is
  out of scope for this environment cleanup.

## Acceptance Checks

- `docker compose ... config` includes `registry-mock` and the
  `registry.pdpp.org` network alias.
- A reference container can fetch
  `http://registry.pdpp.org/connectors/chatgpt` and receive the bundled ChatGPT
  manifest.
- `pdpp.vivid.fish` runs from pushed local-current images and the tracked
  compose files, not from untracked compose edits.
