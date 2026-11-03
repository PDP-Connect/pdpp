# Data connectors for builders

22 October 2026

Material covered: data connectors and the DataConnect developer workflow
([slides and demo files](https://gist.github.com/tnunamak/b79014d233e8f7a49a9154d20e19f37f))

These notes summarize the discussion. They do not change the draft specification.

## Summary

Tim introduced data connectors to builders and demonstrated building one with
DataConnect. The session covered the three repositories in the PDP-Connect
GitHub organization, the lifecycle of a connector, the local build loop, how
manifests extend the PDPP source declaration, the three connector tiers, and
how the community can contribute connectors.

## Discussion

### The three repositories

The PDP-Connect organization on GitHub holds three repositories:

- `pdpp`: the PDPP specification and the project website.
- `data-connect`: the DataConnect application and the reference
  implementation.
- `data-connectors`: the connectors, which implement runtimes for upstream
  sources, together with the shared runtime package
  (`packages/polyfill-connectors`) and authoring tools.

### Connector lifecycle

A connector goes through initialization, collection, possible human
interaction, and error handling. The runtime mediates the connector at each
step.

### Demo: testing and deploying a connector

Tim demonstrated DataConnect testing a connector for Workshop Ledger, a mock
financial service, from local testing through to publishing:

- In DataConnect, open the developer settings, add the local path of the
  connector, and connect with an API key. DataConnect creates the runtime.
- The build loop has three parts: the manifest, the collection code, and the
  schema.
- Fixtures replay a recorded collection, so the connector can be tested
  without calling the source again.

### Manifests and the collection profile

A connector manifest extends the PDPP source declaration. It declares the shape
of the data, the source identifier, the version, the runtime requirements, and
whether a human must be in the loop.

The collection profile is a companion specification for collecting from sources
that the collector does not control. It does not prescribe a runtime.

Connectors emit PDPP-conformant records and verify their own collection,
reporting gaps and incomplete records.

### Tiers

Connectors are listed in one of three tiers: development, preview, or
supported.

### Web connectors on mobile

Web-based connectors can run on mobile through the page shim interface.

### Shared tools and the connector collection

Shared tooling lives in the `polyfill-connectors` package. The connector
collection is growing; `data-connectors` holds 64 connectors on its default
branch at the time of writing.

## Decisions

None formally taken.

## Open questions

None recorded.

## Next steps

- Tim to continue building DataConnect, which is under construction.
- Tim to continue the `data-connectors` tooling: scripts and a command-line
  interface for recording collection runs and storing fixtures.
- Community: submit pull requests, issues, and feature requests to the
  PDP-Connect repositories.
- Community: ship connectors by pull request, for maintainer approval.

[Watch the recording](https://www.youtube.com/watch?v=ozdvKptozd4).
