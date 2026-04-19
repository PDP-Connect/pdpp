# Request Object Neutrality Memo

Date: 2026-04-16  
Status: Working design memo

## Why this memo exists

The current request-shape cutover plan is right about one important thing:

- the server needs one normalized internal request object so transport cleanup can proceed

But the current proposed canonical object also creates a real risk:

- it makes `connector_id` part of the semantic center of the request

That is in tension with the owner decision that the native provider path must be connector-free at the contract level and with the native-vs-polyfill surface sketch, which says the native path must not leak connector/runtime semantics into the public model.

This memo responds directly to that risk.

## The actual problem

There are two distinct things getting conflated:

1. **What the client is asking for**
   - requester identity
   - purpose
   - access mode
   - stream selection
   - field/view/time/resource constraints

2. **How the current implementation fulfills that request**
   - which manifest is consulted
   - whether that means `connector_id`
   - whether the request resolves against a native provider or a polyfill path

The current auth code in [e2e/server/auth.js](/home/user/code/pdpp/e2e/server/auth.js:1) needs both today, but it does not follow that both should live in the same semantic object forever.

The cutover object should therefore be judged by a simple test:

- does it preserve enough information to keep grant issuance working now?
- without teaching that `connector_id` is the core ontology of PDPP?

## Current code pressure

Right now `approveGrant()` directly assumes:

- `params.connector_id`
- `params.streams`
- manifest lookup by `connector_id`

That means any immediate cutover object must still let the auth layer resolve a manifest and validate streams.

So the question is not “can we remove connector identity from the implementation today?”

It is:

- where should connector or realization identity live while transport cleanup proceeds?

## Option 1: Keep `connector_id` inside the canonical semantic selection object

### Shape

```ts
type CanonicalSelectionRequest = {
  client: { client_id: string; client_display?: ... | null };
  selection: {
    type: 'https://pdpp.org/data-access';
    connector_id: string;
    purpose_code: string;
    access_mode: 'single_use' | 'continuous';
    streams: ...;
  };
  compat: { source_shape: 'flat_v0' | 'authorization_details_v1' };
};
```

### Pros

- cheapest code change
- maps directly to current `approveGrant()` needs
- keeps the cutover patch small

### Cons

- treats connector identity as if it were part of the stable semantic center
- makes pending-consent persistence and future auth/profile work train on the old worldview
- makes the “native path must be connector-free at the contract level” decision harder to realize later

### Verdict

Good as a pure transition hack. Bad as a “canonical” object. This option should only be used if it is explicitly labeled transitional and short-lived.

## Option 2: Two-layer object: semantic request plus realization binding

### Shape

```ts
type NormalizedPendingRequest = {
  request_kind: 'pdpp_selection_request';
  request_version: 'e2e.v1';

  client: {
    client_id: string;
    client_display?: {
      name: string;
      uri?: string;
      logo_uri?: string;
      policy_uri?: string;
      tos_uri?: string;
    } | null;
  };

  selection: {
    type: 'https://pdpp.org/data-access';
    purpose_code: string;
    purpose_description?: string;
    access_mode: 'single_use' | 'continuous';
    retention?: {
      max_duration?: string;
      on_expiry?: string;
    } | null;
    streams: Array<{
      name: string;
      necessity?: 'required' | 'optional';
      view?: string;
      fields?: string[];
      time_range?: { since?: string; until?: string };
      resources?: string[];
      client_claims?: Record<string, unknown>;
    }>;
  };

  realization_binding: {
    binding_kind: 'connector';
    connector_id: string;
  };

  compat: {
    source_shape: 'flat_v0' | 'authorization_details_v1';
    raw?: unknown;
  };
};
```

### Pros

- separates the semantic request from the current fulfillment binding
- keeps current implementation needs intact
- gives the native path somewhere else to evolve later without rewriting the semantic core again
- makes it obvious in persistence what is “request” versus “current engine routing”

### Cons

- slightly more verbose
- requires more adaptation in `approveGrant()` than option 1
- may feel a little heavy if treated as the long-term final auth model

### Verdict

This is the strongest balance of honesty and practicality.

It keeps transport cleanup moving while making it explicit that connector identity is an implementation binding, not the ontology.

## Option 3: Replace `connector_id` with a neutral `source_ref`

### Shape

```ts
type NeutralSelectionRequest = {
  client: { ... };
  selection: {
    type: 'https://pdpp.org/data-access';
    source_ref: {
      kind: 'connector' | 'provider';
      id: string;
    };
    purpose_code: string;
    access_mode: 'single_use' | 'continuous';
    streams: ...;
  };
  compat: ...;
};
```

### Pros

- more neutral than `connector_id`
- points toward a future where native providers and polyfill paths fit one slot

### Cons

- introduces a new abstraction before the code can actually use it honestly
- `source_ref.kind = 'provider'` has no real implementation path yet in current auth code
- risks becoming a vague wrapper over `connector_id` that sounds more neutral than it really is

### Verdict

Too abstract for the current cutover. It looks clean on paper, but it asks the implementation to pretend it already has a genuine provider-vs-connector resolution layer. It does not.

## Option 4: Discriminated union for native and polyfill requests

### Shape

```ts
type PendingRequest =
  | {
      mode: 'polyfill';
      client: ...;
      selection: ...;
      connector_binding: { connector_id: string };
    }
  | {
      mode: 'native';
      client: ...;
      selection: ...;
      provider_binding: { provider_id: string };
    };
```

### Pros

- makes the realizations explicit
- could be very honest once both realization paths are truly implemented

### Cons

- far too early
- doubles the normalization and validation surface before the native path is real
- pushes current transport cleanup into a premature architecture exercise

### Verdict

Not suitable for the current tranche.

## Tradeoff summary

### Cheapest

- Option 1

Problem:

- cheapest in code, most expensive in semantic debt

### Most neutral in theory

- Option 3

Problem:

- neutral vocabulary without a real resolution layer behind it

### Most explicit but too early

- Option 4

Problem:

- brings native/polyfill branching into the cutover too soon

### Best balance

- Option 2

Reason:

- it preserves current implementation feasibility
- it keeps semantic request and current fulfillment binding separate
- it does not pretend the native path is already fully real

## Recommendation

Use **Option 2**.

Specifically:

- keep one normalized pending-consent object
- make `selection` semantically about the data-access request
- move `connector_id` out of `selection` and into a separate `realization_binding` object

That gives the code a small but important truth:

- today’s engine still resolves requests through connector manifests
- but that is a fulfillment binding, not the semantic definition of the request itself

## Recommended naming

Do **not** call the object `CanonicalSelectionRequest` if it includes any realization-specific binding.

That name overclaims.

Prefer something like:

- `NormalizedPendingRequest`
- `NormalizedGrantRequest`
- `ResolvedSelectionRequestForConsent`

These names are more honest because they imply:

- normalized for the current server seam
- not necessarily the eternal canonical protocol object

## Smallest viable shape

The smallest viable shape I would recommend now is:

```ts
type NormalizedPendingRequest = {
  request_kind: 'pdpp_selection_request';
  request_version: 'e2e.v1';

  client: {
    client_id: string;
    client_display?: {
      name: string;
      uri?: string;
      logo_uri?: string;
      policy_uri?: string;
      tos_uri?: string;
    } | null;
  };

  selection: {
    type: 'https://pdpp.org/data-access';
    purpose_code: string;
    purpose_description?: string;
    access_mode: 'single_use' | 'continuous';
    retention?: {
      max_duration?: string;
      on_expiry?: string;
    } | null;
    streams: Array<{
      name: string;
      necessity?: 'required' | 'optional';
      view?: string;
      fields?: string[];
      time_range?: { since?: string; until?: string };
      resources?: string[];
      client_claims?: Record<string, unknown>;
    }>;
  };

  realization_binding: {
    binding_kind: 'connector';
    connector_id: string;
  };

  compat: {
    source_shape: 'flat_v0' | 'authorization_details_v1';
    raw?: unknown;
  };
};
```

## Why this is the smallest viable shape

- it keeps grant-building moving with the least code disruption
- it lets pending-consent persistence stop depending on raw transport shape
- it avoids falsely canonizing `connector_id` as part of PDPP’s semantic center
- it leaves a clean slot for future native-provider binding without rewriting the semantic request object again

## Implementation implication

If this recommendation is accepted, the cutover plan should change in one specific way:

- wherever the plan currently says `selection.connector_id`, it should become `realization_binding.connector_id`

And the plan should explicitly say:

- this object is the normalized internal pending-grant request for the current reference server
- not the final ontology of all future PDPP authorization flows

## Final recommendation

Keep the transport cleanup moving now, but do not pay for that speed by teaching the wrong ontology.

The right compromise is:

- semantic request in `selection`
- current fulfillment binding in a separate `realization_binding`
- honest naming that does not pretend the transitional internal object is the forever-canonical PDPP request model
