# Open question: owner self-export needs a connector-list endpoint

**Status:** open
**Raised:** 2026-04-19
**Trigger:** building a self-export dashboard at `apps/web/src/app/dashboard/` exposed that a spec-compliant PDPP client cannot enumerate what connectors have data for the owner without reading the polyfill package's local filesystem.

## What the spec says

`spec-core.md` Tier 1 RS requirement #12:

> SHOULD support owner-authenticated access to the `/v1/streams/{stream}/records` query endpoints without a client grant, allowing the data subject to export their own data directly (self-export).

The self-export path uses an owner token + the same record-query endpoints that client grants use. This is clean when the caller already knows *which streams from which connectors* they want.

## The gap

A self-export UI — or any owner-side tool — typically doesn't know the connector list upfront. It needs a discovery step:

1. "What connectors have data for me?"
2. For each, "What streams and what record counts?"
3. Then: query records.

Step 1 has no spec-defined endpoint for owners:

- `GET /v1/streams` is query-scoped and requires `connector_id` when called under an owner token (per `resolveOwnerReadScope` in the reference implementation).
- `POST /connectors` exists for manifest registration; there is no `GET /connectors`.
- `GET /v1/streams/{stream}/records` requires knowing the stream (and for owner tokens, the connector).

Today's dashboard works around this by reading `packages/polyfill-connectors/manifests/*.json` directly from disk. That works on a single-host install but:

- breaks for hosted PDPP deployments where the UI has no filesystem access to the server's manifest registry
- couples the self-export client to the polyfill package layout
- makes the spec's "owner self-export" SHOULD incomplete — the spec gives you the query API but not the discovery step to use it

## Three framings to resolve

### A. Add an owner-authenticated connector-list endpoint

```
GET /v1/connectors
Authorization: Bearer <owner_token>

→ [
  { "connector_id": "...", "display_name": "...", "stream_count": 7, "record_count": 12450 },
  ...
]
```

Pro: clean, discoverable, matches the data-plane shape. Con: leaks the connector inventory by virtue of listing it — arguably already true for anyone who holds an owner token.

### B. Expose connector-list via a new scope on the existing `/v1/streams`

Call `/v1/streams` with an owner token and no `connector_id` → return all streams across all connectors grouped by connector. Today the RS refuses this for owner tokens (only grant tokens get it via grant scope).

Pro: reuses an existing endpoint. Con: breaks the symmetry between owner and client callers (client calls without connector_id resolve via grant scope; owners would resolve via "all").

### C. Keep self-export limited to cases where the client already knows the connector

Document that self-export is *not* a discovery tool; the caller must obtain connector IDs out-of-band (manifest registry, service catalog, etc.). Downgrade the SHOULD to a MAY or add an explicit note.

Pro: minimal spec change. Con: self-export-UI builders have no canonical discovery path, which undermines the feature's usefulness.

## My take

**(A) is likely right.** The owner token is already scoped to a single subject and the RS already derives that subject from introspection. A connector-list endpoint is the natural complement to the existing stream-list endpoint — it lets the owner ask "what do I have?" symmetrically with "what's in a stream?"

## Cross-cuts

- `rs-storage-topology-open-question.md` — if the RS is federated per-connector, listing connectors becomes a federation-level operation. Relevant to consider jointly.
- `spec-core.md` Tier 1 RS #12 — the SHOULD for self-export is incomplete without discovery. Worth elevating or clarifying.
- `connector-configuration-open-question.md` — whatever shape `credentials_schema` / `options_schema` take, they'd show up in the connector-list response too.

## Action items

- [ ] Decide whether self-export needs discovery or not (probably yes)
- [ ] If yes, add `GET /v1/connectors` (or equivalent) to the spec
- [ ] Reference implementation adds the endpoint; dashboard migrates from filesystem-read to API-call

## Secondary finding

There is no stable-ports "start the reference server" CLI today — only ad-hoc `node reference-implementation/server/index.js` invocations or the orchestrator's ephemeral-port embedded server. Running a self-export client against the reference requires knowing which ports the server binds. This is an implementation packaging issue, not a spec question; flagged separately.
