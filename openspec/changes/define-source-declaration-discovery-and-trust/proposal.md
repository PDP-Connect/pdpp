# Proposal: Define Source Declaration discovery and trust

## Why

The Source Declaration contract needs a bounded discovery and trust boundary.
The authorization server must not let an ordinary authorization request choose
an unaccepted authority, and a later declaration must not silently replace the
accepted source or revision.

## What changes

- Add provider-native discovery through RFC 9728 protected-resource metadata.
- Publish the discovery and trust rules as an authoritative root companion
  specification.
- Define `pdpp_source_declaration_uri` as one HTTPS URI string with no fragment
  or user information.
- Require the RFC 9728 returned-resource equality rule, plus the explicit PDPP
  source ID equality rule.
- Define owner/operator onboarding for provider-native resources and trusted
  catalog, registry, or local inputs for connector and community sources.
- Separate resource authority from publisher attribution.
- Define bounded HTTPS retrieval and immutable accepted revision content.
- Keep display escaping and response/parser limits as implementation policy.
- Block declarations locally for new consent without automatic historical grant
  revocation. Defer quarantine records and workflow.

This change consumes the Source schema and accepted snapshot from the Source
Declaration contract. It does not redefine grants, consent snapshots, Core
schema, or Collection. Reference-server metadata emission, declaration
retrieval, onboarding adapters, persistence, and consent integration are
deferred to implementation changes.

## Capabilities

### Added

- `source-declaration-discovery-and-trust`

### Modified

- None

### Removed

- None

## Impact

The protocol gains an authoritative discovery boundary, immutable
accepted revisions, and a protected-resource metadata extension for
provider-native sources. The public contract package and focused protocol
contract tests are updated. Collection remains optional.
