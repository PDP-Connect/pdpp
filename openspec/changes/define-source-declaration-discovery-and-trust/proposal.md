# Proposal: Define Source Declaration discovery and trust

## Why

The Source Declaration contract needs a bounded discovery and trust boundary.
The authorization server must not let an ordinary authorization request choose
an unaccepted authority, and a later declaration must not silently replace the
accepted source or revision.

## What changes

- Add provider-native discovery through RFC 9728 protected-resource metadata.
- Define `pdpp_source_declaration_uri` as one HTTPS URI string with no fragment.
- Require decoded Unicode code-point resource comparison without normalization,
  plus the explicit PDPP source ID equality rule.
- Define owner/operator onboarding for provider-native resources and trusted
  catalog, registry, or local inputs for connector and community sources.
- Separate resource authority from publisher attribution.
- Define bounded HTTPS retrieval and exact accepted UTF-8 body-byte immutability.
- Keep display escaping and response/parser limits as implementation policy.
- Block declarations locally for new consent without automatic historical grant
  revocation. Defer quarantine records and workflow.

This change consumes the Source schema and snapshot from the first Source
Declaration change and the stable authorization context from PR89. It does not
redefine grants, consent snapshots, Core schema, or Collection. Legacy
acceptance advertisement remains a PR89 dependency and is not defined here.

## Capabilities

### Added

- `source-declaration-discovery-and-trust`

### Modified

- None

### Removed

- None

## Impact

The AS gains an explicit discovery authority boundary, immutable accepted
revisions, and metadata support for provider-native sources. The reference
implementation, contract package, persistence adapters, and focused tests are
updated. Collection remains optional.
