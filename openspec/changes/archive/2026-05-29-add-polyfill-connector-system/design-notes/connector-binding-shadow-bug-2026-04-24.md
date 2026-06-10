Status: open
Owner: the owner
Created: 2026-04-24
Updated: 2026-04-24
Related: add-polyfill-connector-system; reference runtime controller; protocol-violation diagnostics

# Connector Fixture Binding Shadows Polyfill Connectors

## Summary

`resolveDefaultConnectorPath()` currently resolves reference fixture connector ids before polyfill connector paths. Three fixture manifests use the same `connector_id` values as shipped polyfill connectors: GitHub, Reddit, and Spotify. When a run requests one of those ids, the runtime can dispatch the seed fixture connector instead of the real polyfill connector.

This explains the GitHub failure diagnosed on April 24, 2026: the seed connector emitted progress for `commits`, but the real polyfill GitHub manifest scope did not declare `commits`, so the runtime correctly failed the run with `connector_protocol_violation` / `progress_for_undeclared_stream`.

## Current Behavior

The controller path resolver currently prioritizes fixture ids:

```ts
export function resolveDefaultConnectorPath(connectorId: string): string | null {
  if (loadReferenceFixtureConnectorIds().has(connectorId)) {
    return SEED_CONNECTOR_PATH;
  }
  return loadPolyfillConnectorPaths().get(connectorId) || null;
}
```

Priority is therefore:

1. Reference fixture connector ids.
2. Polyfill connector paths.

## Collision

These reference fixture manifests declare the same connector ids as their corresponding polyfill manifests:

| Fixture manifest | `connector_id` |
|---|---|
| `reference-implementation/manifests/github.json` | `https://registry.pdpp.org/connectors/github` |
| `reference-implementation/manifests/reddit.json` | `https://registry.pdpp.org/connectors/reddit` |
| `reference-implementation/manifests/spotify.json` | `https://registry.pdpp.org/connectors/spotify` |

All three fixture ids point at `reference-implementation/connectors/seed/index.js`, a single mock binary that emits a fixed fixture dataset for multiple providers.

When the scheduler asks for `connector_id=https://registry.pdpp.org/connectors/github`, the fixture set wins. The seed connector then emits data/progress that is not necessarily valid under the real polyfill GitHub manifest.

## Candidate Fixes

### Option 1: Invert Priority

Resolve real polyfill connector paths before fixtures:

```ts
export function resolveDefaultConnectorPath(connectorId: string): string | null {
  const polyfillPath = loadPolyfillConnectorPaths().get(connectorId);
  if (polyfillPath) {
    return polyfillPath;
  }
  if (loadReferenceFixtureConnectorIds().has(connectorId)) {
    return SEED_CONNECTOR_PATH;
  }
  return null;
}
```

Benefits:

- Fixes GitHub, Reddit, and Spotify runs so they exercise the real polyfill connectors.
- Leaves fixture ids without polyfill collisions, such as `northstar_hr_native`, unchanged.
- Leaves tests that pass `connectorPathResolver` explicitly unchanged.

Risk:

- Changes first-run demo behavior if the current priority was intentionally using seed fixtures as credential-free stand-ins for common providers.

### Option 2: Rename Fixture Connector IDs

Rename colliding fixture ids so they cannot shadow real provider ids, for example:

- `https://registry.pdpp.org/connectors/github-fixture`
- `https://registry.pdpp.org/connectors/reddit-fixture`
- `https://registry.pdpp.org/connectors/spotify-fixture`

Benefits:

- Makes the choice explicit in the connector id.
- Preserves fixture-backed demos under distinct ids.
- Eliminates shadowing by construction.

Risk:

- Requires updating any demo flows, docs, tests, or snapshots that assume fixture manifests use real provider ids.

### Option 3: Environment Flag

Introduce a flag such as `PDPP_USE_SEED_FIXTURES=1` that chooses fixture priority. The default would favor real polyfill connectors; demo instances could opt into fixture priority.

Benefits:

- Allows both local demo and real connector behavior.

Risk:

- Adds another operational mode and another source of "why did this connector run differently here?" confusion.

### Option 4: Keep Priority but Make It Visible

Leave current priority unchanged, but warn when a seed fixture is selected for an id that also has a real polyfill connector. Optionally emit an early run event that marks the run as seeded.

Benefits:

- Lowest behavioral risk.
- Makes future failures easier to diagnose.

Risk:

- Does not fix the root shadowing behavior.

## Recommendation

Prefer Option 2 if demo behavior matters: rename fixture connector ids so fixture-vs-real is visible at the identity layer. This fits the reference implementation's "inspect, don't hide" posture and avoids environment-mode ambiguity.

If the immediate goal is to unblock real connector runs with minimal code, Option 1 is the smallest safe runtime change, provided tests pin the intended priority.

## Related Diagnostic Improvement

The structured protocol-violation vertical slice now makes this failure class easier to recognize. A future occurrence should produce a bounded shape similar to:

```json
{
  "violation": {
    "subtype": "progress_for_undeclared_stream",
    "message_type": "PROGRESS",
    "stream": "commits",
    "expected": ["user", "repositories", "starred", "issues", "pull_requests", "gists"],
    "received": "commits",
    "last_valid_event_id": "evt_...",
    "last_valid_event_type": "run.state_staged"
  }
}
```

That does not replace fixing the binding priority, but it makes the symptom self-diagnosing enough to trace back to fixture-vs-polyfill shadowing quickly.
