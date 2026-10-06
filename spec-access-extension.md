# PDPP extended access profile

Status: Draft extension profile; profile version 0.1.0
Date: 2026-10-06

## 1. Scope and status

This companion profile defines optional, transport-neutral extensions for PDPP authorization and disclosure: owner-selected authorization, grant packages, and bounded presentation reads. These features are independent; an implementation MAY support any subset.

This profile does not broaden a Core grant, replace the Core resource-server interface, or define a new authorization framework. A claiming implementation MUST satisfy applicable Core conformance requirements. Core remains the authority for grant shape, result delivery, lifecycle, and enforcement.

## 2. Requirements language

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in capitals.

## 3. Profile claims and common boundary

A conformance claim MUST identify the profile version, transport binding, protected-resource surface, and data surface covered, and MUST list each supported feature separately. Claiming one feature MUST NOT imply support for another, and no implementation is required to support all features.

If an implementation claims a feature, its advertised support and actual behavior MUST satisfy every requirement for that feature. The transport binding MUST select and validate the intended protected-resource identifier for each request or package token.

This profile does not redefine the Core client-visible authorization result. Clients and authorization servers MUST follow Core Section 7 for the complete `{ type, grant }` result, including refresh responses, and client inspection before disclosure. The authorization-details envelope remains the deployment's RFC 9396 binding.

A separated resource server MUST resolve an access token through authenticated RFC 7662 introspection; a co-located deployment MAY use an authenticated local equivalent. The response MUST contain complete request context. Positive introspection caching MUST respect Core's maximum positive-cache lifetime.

Malformed, incomplete, contradictory, or context-mismatched required introspection data MUST fail closed. Unknown extension members MUST NOT alone cause rejection or confer authority. The resource server MUST determine `pdpp_token_kind` from the authenticated result, never token syntax.

## 4. Owner-selected authorization

An authorization server MAY support owner-selected authorization with RFC 9396 type `https://pdpp.dev/owner-selection`. This OPTIONAL feature is not a replacement for Core type `https://pdpp.dev/data-access`.

An AS supporting owner selection MUST advertise `https://pdpp.dev/owner-selection` in `authorization_details_types_supported`. A client MUST establish support before requesting it.

The request MUST identify the requesting client through the selected authorization binding and MUST contain `purpose_code` and `access_mode`. It MAY contain `purpose_description`, `retention`, and a non-empty `source_ids` array. `access_mode` MUST retain Core's `single_use` or `continuous` semantics.

The AS MAY resolve purpose and retention from recipient-authorized standing terms, but MUST identify and version those terms in retained consent evidence. An owner-authored condition alone MUST NOT be treated as recipient acceptance. This profile creates no unreviewed terms field or unilateral recipient commitment.

Every listed source MUST have an accepted declaration known to the AS. The request MUST NOT introduce an unaccepted declaration URI, source authority, or resource authority. `source_ids`, when present, MUST limit selection to those sources. When absent, the AS MAY offer any eligible accepted source but MUST NOT disclose that source inventory to the client.

Duplicate source identifiers or unknown request members MUST produce RFC 9396 `invalid_authorization_details`. An empty final selection MUST produce `access_denied`. The request does not require an initial stream selector; the owner's selection supplies that choice.

An owner-selection detail carries one purpose. Every detail it resolves has that purpose. A client that needs several purposes MUST send one owner-selection detail per purpose, in one request or in separate requests. The owner approves or declines each resolved detail on its own, as Core Section 7 requires.

Core's [AI training consent](spec-core#ai-training-consent) rule applies inside owner selection. When an owner-selection detail has purpose `https://pdpp.dev/purpose/ai_training`, the owner MUST select each source for it by a distinct affirmative action. The AS MUST NOT present any such source as selected by default. The owner MUST be able to approve every other detail in the transaction while declining the `ai_training` detail.

Before token issuance, the AS MUST resolve each selected source to one ordinary Core data-access detail with the owner-selection detail's purpose, and then to one grant. The result MUST contain one complete `{ type, grant }` element per issued grant. Each grant MUST contain explicit streams, instance handles, fields, resources, and time constraints required by Core and the retained declaration snapshot. Its `subject.id` and instance handles are the requesting client's pairwise identifiers ([Pairwise identifiers](spec-core#pairwise-identifiers)). For a stream with `resources`, the owner selects exactly one instance, as Core Section 7 requires. Each resolved field set includes the stream's schema-required fields; they are the per-stream consent floor that Core Section 6 defines. Owner narrowing MUST NOT remove them.

If the transaction issues more than one grant, the AS MUST issue a package under Section 5. An AS that cannot issue a package, because it lacks package support or because an element lacks `detail_id`, MUST limit this flow to one issued grant per transaction.

An AS that does not support this type MUST reject it as unsupported and MUST NOT silently process it as Core data access. Absence of `authorization_details` is not opt-in and MUST NOT enable this flow. Final owner review MUST identify the client, resolved data, purpose, access mode, retention, and recipient-authorized standing terms affecting the decision.

## 5. Grant packages

A grant package is one access token, and at most one refresh-token family, that covers several ordinary Core grants. A package is a profile binding over those grants, not a Core grant or Core token kind. Each covered grant is a child.

### 5.1 Children and detail correlation

An AS MAY issue a package when a transaction requests more than one detail, or an owner-selection detail, and the client sent `detail_id` on every element. A resolved detail covers one subject, one source, and one purpose (Core Section 7). A requested Core `data-access` detail is one resolved detail. An owner-selection detail resolves to one detail per selected source (Section 4).

The package MUST contain one complete Core grant per issued resolved detail. Several children MAY share a source, for example when their purposes differ. `grant_id` identifies a child. Subject, source, and purpose together are not a key.

Each child MUST retain its `source.id`, declaration revision, resolved constraints, client and subject bindings, and lifecycle. The AS MUST NOT merge fields, instances, resources, or constraints across children. The AS MUST bind every child to the authenticated client and subject and MUST reject packages combining different clients or subjects.

Every child is a Core grant for the same client, so it carries that client's pairwise identifiers ([Pairwise identifiers](spec-core#pairwise-identifiers)). Instance handles are scoped to the client and source, not to the child: two children that cover the same instance list the same handle, and their records carry the same `instance_id`. The client MAY relate records across its own children by `instance_id` and `id`. This does not permit the resource server to compute a result across children (Section 5.3). Each child is subject to Core's `resources` rule: a child stream with `resources` lists exactly one handle. The AS MUST reject a detail that asks for `resources` in more than one instance with RFC 9396 `invalid_authorization_details`, and MUST NOT split it into several children.

Correlation uses a `detail_id` member on each requested `authorization_details` element: a string, unique within the request, chosen by the client. In the OAuth binding, an AS signals package support by advertising `pdpp_package_disconnect_endpoint` (Section 5.6). A client MUST send `detail_id` only to an AS that advertises that endpoint. A client that can accept a package MUST then send `detail_id` on every element. The AS MUST reject an empty or duplicate `detail_id` with RFC 9396 `invalid_authorization_details`. It MUST NOT issue a package for a request in which an element lacks `detail_id`.

The token response that first issues the package MUST contain `pdpp_detail_outcomes`: an array with one `{ detail_id, grant_ids }` entry per requested detail. `grant_ids` lists the `grant_id` of every child issued for that detail. An empty `grant_ids` means the detail was declined. For an owner-selection detail, the entry lists only the issued children. The AS MUST NOT reveal which sources the owner saw, declined, or could have selected.

The owner approves or declines each resolved detail on its own. A package with exactly one issued child is still a package: the client selects that child as Section 5.3 requires. When no child is issued, the AS MUST refuse the authorization with `access_denied` and MUST NOT issue a token.

### 5.2 Introspection and read deadlines

An active package introspection response MUST report `pdpp_token_kind: "grant_package"`, the `authorization_details` of every child the token carries, and `pdpp_grant_status`. `pdpp_grant_status` maps the `grant_id` of every child of the package to its current `active` boolean. A child that the token no longer carries is reported `false`. The AS MUST compute each status from current lifecycle and report top-level `active: false` when the token is invalid or no child is active. An inactive response MAY omit the grant context.

For each `single_use` child, an active response MUST also report the child's read deadline in `pdpp_grant_read_until`, which maps that child's `grant_id` to a Unix epoch time. The deadline is the expiry of the first package token that carried the child, which ends the child's Core read window. The AS MUST fix the deadline at that issuance and MUST NOT change it. A child is inactive after its deadline, even if its underlying grant has not expired.

The resource server MUST NOT use a positive cache entry for a child after that child's read deadline. A signed blob URL for a `single_use` child MUST expire no later than the child's read deadline, and blob redemption MUST check the deadline again.

Package introspection omits the singular Core client-context `grant_id`; this extension context MUST NOT be treated as an ordinary Core client context.

An active package introspection response MUST also carry Core's RS-only `pdpp_instance_bindings` for every child the token carries. Each entry is `{ grant_id, source_id, stream, instance_id, rs_instance }`, one for each child, stream, and handle in that child's grant, where `grant_id` names the child. The Core consistency rule applies across the whole response: every entry for one `(source_id, instance_id)` MUST name the same `rs_instance`, and the resource server MUST reject a response with conflicting entries as `grant_invalid` before it serves data under any child. The resource server MUST resolve handles for a request only from the entries of the selected child. A request under a child that needs a handle with no entry for that child, or whose entry names no stored instance, fails with 403 `grant_invalid`, as Core Section 8 defines; the failure does not affect another child. The AS MUST NOT return `pdpp_instance_bindings` or `rs_instance` to a client.

The package token MUST remain bound to the intended protected resource selected by the transport binding. Its token kind MUST NOT confer owner authority. A resource server with package endpoints MUST list `grant_package` in its `pdpp_token_kinds_supported` metadata; Core Section 8 lets a companion profile add a token kind.

A Core-only endpoint implements Core and not this binding. It MUST reject a token with `pdpp_token_kind: "grant_package"`. A package endpoint implements this binding. In the HTTP binding, package endpoints reuse the Core Section 8 paths and response shapes. They add the child selector of Section 5.3 and answer each request as the Core endpoint would under the selected child's grant alone. A package endpoint also serves Core client tokens as Core defines. A resource server that implements the binding MUST identify its package endpoints in the protected-resource surface of its conformance claim (Section 3).

### 5.3 Child selection

Every disclosure made with a package token, other than child discovery (below), MUST name exactly one child by `grant_id`. This applies to list streams, stream metadata and schema reads, record lists, single-record reads, `changes_since` reads, blob fetches, presentation operations such as search (Section 6), and each sub-call of an operation that fans out across children. There is no implicit selection, even when the package has one child or one active child.

Child discovery is exempt from the selector rule. A binding MAY define an operation that lists the children of the presented token. It returns only the approved grant metadata of those children and their current status. Any subject, grantor, or instance identifier it returns is the client's pairwise value from the child grant, and it lists only the instance handles that the child grant lists. It MUST NOT return records, derived facts, or inventory of sources, grants, or instances that the owner did not approve.

The resource server MUST reject a missing, malformed, repeated, or unknown selector before it processes the request. An unknown selector names a `grant_id` that is not a child of the package. The HTTP binding returns HTTP 400 `invalid_request` with `param` naming the selector. The resource server MUST NOT fall back to another child.

The resource server MUST verify client, subject, intended-resource, and child bindings before it uses the selected child. It MUST reject incomplete status mappings and context mismatch, and MUST require both package and selected-child active status for disclosure.

The resource server MUST authorize each disclosure under the selected child alone. It MUST NOT combine the constraints of several children to authorize a disclosure. It MUST NOT compute a result across children, such as a count, ranking, join, deduplication, or summary. An operation that spans children MUST make one sub-call per child, and each sub-call MUST name its own child. A binding MAY return the sub-call results in one envelope. Each entry is labeled with its child's `grant_id` and is either that child's independently authorized result or that child's error, including `package_child_inactive`. One entry's error does not change another entry.

A read names an instance by Core's `instance_id`. The resource server computes the Core selector requirement from the selected child's grant alone: a single-record read or delete requires `instance_id` when that child's grant lists more than one handle for the stream, and every blob fetch requires `instance_id`. A handle that the selected child's grant does not list for the stream is not found, as Core Section 8 defines, even when another child of the package lists it. Every record, tombstone, and `fetch_url` served under a child carries the client's handle, and each `resource_ref` is resolved or redacted under the selected child's grant alone, as Core Section 4 defines.

Cursors, `changes_since` tokens, signed blob URLs, and cache entries are bound to the selected child. The resource server MUST reject a cursor or `changes_since` token presented under another child with HTTP 400 `invalid_cursor`. A signed blob URL binds its child at issuance, and redemption MUST check that the child is still active. A cache of responses or derived data MUST include the child's `grant_id` in its key. It MUST NOT be keyed by bearer or source alone.

The AS MUST give every package child a `grant_id` that matches the grammar `1*( ALPHA / DIGIT / "." / "_" / "~" / "-" )` (RFC 5234 ABNF; the characters `[A-Za-z0-9._~-]`). This constraint applies to package children only.

The HTTP binding carries the selector in the `PDPP-Grant-Id` request header. A request made with a package token MUST contain exactly one `PDPP-Grant-Id` field line. For a Core client token the header is OPTIONAL. After normal HTTP field parsing removes leading and trailing whitespace, the value MUST match the `grant_id` grammar. The resource server MUST reject a request with more than one such field line, and a value that contains a comma, because an HTTP recipient can combine repeated field lines into one comma-separated value ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) Section 5.3). The resource server compares the value with child `grant_id` values exactly and case-sensitively. A resource server that supports packages MUST reject a `PDPP-Grant-Id` header sent with a Core client token unless its value equals that token's `grant_id`. The MCP binding carries the selector in the `grant_id` tool argument ([MCP read profile](spec-mcp-profile), Section 3).

### 5.4 Inactive selected child

A selected child is inactive when it is revoked or expired, when it is past its read deadline, or when the token no longer carries it. When the package token is still active, a request that selects an inactive child fails with a terminal error. It is not an authorization challenge.

In the HTTP binding, the resource server MUST return HTTP 403 with a `WWW-Authenticate: Bearer` challenge that has no `error="insufficient_scope"` parameter, and a structured error with type `permission_error` and code `package_child_inactive`. The MCP binding defines its own result ([MCP read profile](spec-mcp-profile), Section 3).

A client MUST NOT start re-authorization automatically on `package_child_inactive`. Asking for replacement access is a separate authorization request that the owner reviews. The resource server MUST NOT substitute another child.

When no child is active, the package token is inactive. The resource server then returns HTTP 401 with Bearer error `invalid_token`, as Core Section 8 requires for every inactive token.

### 5.5 Issuance, refresh, and expiry

The AS MUST consume every `single_use` child atomically with first package-token issuance. It MUST reject later issuance against a consumed child, except a successor access token from the same refresh-token family inside the child's read window (Core Section 7).

The AS MAY issue a refresh token only when at least one child is `continuous` (Core Section 10). A refreshed access token carries every active `continuous` child and each active `single_use` child only until the child's read deadline, never after. Refresh never extends a read deadline or opens a second window. The AS MUST apply Core refresh rotation, family-reuse revocation, expiry, and revocation rules. Package-token expiry or revocation MUST deny all child reads.

### 5.6 Revocation and disconnect

Core Section 10 defines which credential revocation ends which grants. For a package:

- Revoking the package refresh token, current or superseded, ends every child that its family covers and every access token issued under them.
- Revoking a package access token ends that token. It also ends the children only when no refresh-token family covers them.
- Withdrawing one child is a grant-level action at the AS, by owner action or a grant-management operation. It MUST NOT revoke the package credential or end another child. The package token stays active while another child is active.

An AS that issues packages MUST offer a client-callable package disconnect. Disconnect ends every child of the package, the refresh-token family, and every access token issued under the package. It is distinct from revoking one access token, which can leave the family and the children active, and from withdrawing one child.

Disconnect MUST work when the client no longer holds the current refresh token. The client presents any access token or refresh token that the AS issued for the package, active, expired, or superseded, and authenticates as Core's OAuth binding requires for token revocation. The AS MUST verify that the token was issued to that client for that package. Disconnect is idempotent: a repeated call, or a call after the package has ended, succeeds and changes nothing.

In the OAuth binding, the AS MUST advertise the operation as `pdpp_package_disconnect_endpoint` in its RFC 8414 metadata. The request and response follow [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) Section 2: a `POST` with a `token` parameter and an optional `token_type_hint`, and HTTP 200 on success.

## 6. Bounded presentation reads

A resource server MAY expose bounded presentation operations over grant-authorized input. Supported behavior MUST be documented and MUST bind its conformance claim. Operations MAY include search, count, preview, or summary computation, but this profile defines no mandatory endpoint.

Every record, field, identifier, count, search hit, preview, summary, or other derived fact is a disclosure. The resource server MUST compute it only from records and fields authorized by the applicable Core grant and MUST apply source, declaration snapshot, stream, instance, time, field, resource, lifecycle, and expiry constraints before computation.

The resource server MUST NOT search a denied field and return merely projected hits, or use current declaration capabilities to widen or reinterpret an issued grant. If an authorized projection cannot be applied, it MUST redact the affected result or fail closed; error text MUST NOT reveal denied existence.

A presentation result that identifies a record, including a search hit, preview, or fan-out entry, MUST give the record's `instance_id` with its `id`, using the handle from the applicable grant. A `resource_ref` or `blob_ref` in a presentation result MUST take the form Core Section 4 defines for served records: a resolved or redacted reference, and a `fetch_url` that carries `instance_id`. A presentation result MUST NOT contain `rs_instance`, the introspection `subject_id`, or any other identifier that is not pairwise for the client.

A presentation result MUST carry `inputs`: one entry for each instance and stream the computation consulted, including those that matched nothing. Each entry gives the client's pairwise `instance_id`, the `stream`, and the `last_success_at` value, as defined in Core [Freshness metadata](spec-core#freshness), that the computation used, or null when it is unknown. `inputs` states which facts the result drew on. It is not an as-of or completeness guarantee, and a result MUST NOT replace it with a single blended timestamp.

Each `last_success_at` in `inputs` follows Core's coarsening rule for client-token responses: the resource server truncates it to its declared `pdpp_freshness_granularity_seconds` and does not report it before its interval ends. A resource server that returns `inputs` MUST declare that granularity, as Core requires of one that attaches `freshness`. An `inputs` entry carries no failure time.

In a fan-out envelope (Section 5.3), each entry that holds a result is a separate presentation result under its own child and carries its own `inputs`, computed under that child alone. The envelope carries no combined `inputs`.

Free-text output, such as a generated summary, discloses all of its content. This profile does not guarantee that it reveals less than its inputs.

A presentation result MUST NOT create a new declared source, durable derived dataset, onward disclosure right, or grant authority. Durable derived data requires a separate declared source and authorization contract. This profile defines no action rights or mixed read-and-action rules; Core Section 8's [existing-permissions](spec-core#existing-permissions) boundary governs those operations.

## 7. Conformance boundary

Each optional feature is independently conformance-scoped. Owner-selection claims cover request, resolution, review, and result behavior. Package claims cover issuance, detail correlation, introspection, resource binding, child selection, inactive-child errors, refresh, and disconnect. Presentation claims cover only documented bounded operations, authorized-input computation, and `inputs` reporting.

All claims remain subject to Core validation, authorization, disclosure, snapshot, revocation, expiry, result, and resource-server requirements. The implementation MUST fail closed whenever required authority, binding, status, projection, or complete result context is absent or ambiguous.
