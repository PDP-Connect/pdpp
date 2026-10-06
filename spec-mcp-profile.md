# PDPP Model Context Protocol (MCP) read profile

Status: Draft extension profile; profile version 0.1.0
Date: 2026-10-06

## 1. Scope

This profile binds an MCP Streamable HTTP resource to PDPP-granted data access. It defines the additional obligations for a PDPP-governed MCP surface, not a replacement for Core's resource-server interface.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL have the meanings defined in RFC 2119 and RFC 8174 when capitalized.

A conformance claim MUST identify the profile version, MCP resource identifier, covered sources, and covered tools or operations. It MUST identify any supported features of the [extended access profile](spec-access-extension). The claim MUST NOT imply coverage of unlisted data or operations.

## 2. Authorization binding

The MCP client, authorization server, and resource server MUST satisfy the [MCP HTTP authorization requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), including protected-resource metadata, resource indicators, audience validation, and the prohibition on token passthrough.

The MCP server MUST resolve each data-access token to an active Core client grant or an extended-access grant package. It MUST reject owner tokens and tokens intended for the owner control plane. Package acceptance MUST follow the extended access profile; it does not permit package tokens at Core endpoints.

A downstream request MUST use a credential intended for the downstream resource and preserve the applicable grant restrictions. An upstream credential with broader permissions MUST NOT widen the MCP client's approved access.

Clients and authorization servers MUST follow Core's authorization-result requirements. The client MUST inspect the complete resolved result before its first data-disclosing tool call. Optional owner selection and package issuance MUST follow the extended access profile, rather than MCP-specific grant formats.

## 3. Tool disclosure

The MCP server MUST map each data-disclosing operation to its applicable Core grant or package child grants and enforce their resolved restrictions on every call. It MUST reject ambiguous mappings. Tool annotations and tool availability MUST NOT substitute for authorization.

With a package token, the child is always explicit. Every data-disclosing tool call, except the child-discovery tool below, MUST carry a `grant_id` argument, and each such tool MUST declare `grant_id` in its input schema. A call names exactly one child unless the tool accepts a list of `grant_id` values to fan out. Such a tool MUST make one sub-call per named child. It MUST NOT combine the constraints of several children or compute a result across children. It returns an envelope with one entry per named child, labeled with its `grant_id`. Each entry is either that child's result or that child's error object, including `package_child_inactive` with the text below. The tool result has `isError: true` only when every entry is an error. No tool selects a child implicitly or reads all children by default. The server MUST reject a missing, malformed, or unknown `grant_id` before it processes the call, with a tool result that has `isError: true`. Clients do not reliably validate arguments against the input schema, so this check belongs to the server.

The MCP server MUST offer a callable child-discovery tool, scoped to the presented package token. For each child the tool returns the `grant_id`, source, purpose, streams with their `instance_ids`, access mode, and current status. Any subject, grantor, or instance identifier it returns is the client's pairwise value from the child grant ([Pairwise identifiers](spec-core#pairwise-identifiers)), and it lists only the handles that the child grant lists. It MUST NOT return records, derived facts, or grants, sources, or instances that the token does not cover. The discovery tool takes no `grant_id` argument; it is the child-discovery exemption of the extended access profile. Server instructions MAY also describe the children, but they are fixed at initialization and cannot show later revocation, so they do not replace the tool.

When the server forwards a package-authorized call to a PDPP resource server, it MUST target a package endpoint in that resource server's declared package surface, never a Core-only endpoint. Each downstream request MUST name the same child and, when the call names an instance, the same `instance_id`. Over HTTP it uses the `PDPP-Grant-Id` header defined by the extended access profile.

When a call names one child, that child is inactive, and the package token is active, the server MUST return a tool result with `isError: true`. In a fan-out call, the same error object and text go in that child's entry, and the envelope rule above sets `isError`. Its `structuredContent` MUST contain an `error` object with `code` equal to `package_child_inactive` and `grant_id` naming the child. Its text content MUST state that access under that grant has ended, that the call must not be retried, and that the owner can be asked if the access is needed again. For example: "Access to grant grt_8f72a1b3 has ended. Do not retry this call. Ask the owner if this access is needed again." The server MUST NOT answer this case with a transport-level HTTP 401 or 403. A client MUST NOT start re-authorization automatically on `package_child_inactive`, and the server MUST NOT substitute another child. When no child is active, the package token is inactive and the server returns HTTP 401 with Bearer error `invalid_token`.

Tool results identify records as Core does. Every record or tombstone in a tool result carries `instance_id` next to `id`, and that pair identifies the record within its stream. The handle is the one the applicable grant lists: the Core grant, or the named child's grant. A `resource_ref` is resolved or redacted and a `blob_ref` `fetch_url` carries `instance_id`, as Core Section 4 defines. A tool that reads one record takes an `instance_id` argument, which is REQUIRED when the applicable grant lists more than one handle for the stream. A tool that fetches a blob always takes an `instance_id` argument. Before it looks up the record or blob, the server MUST reject a call that lacks a required `instance_id` with a tool result that has `isError: true`. It MUST treat a handle that the applicable grant does not list as not found.

A tool input schema, result, error, or server instruction MUST NOT contain an identifier for a subject, grantor, or instance that is not the client's pairwise value, such as the introspection `subject_id` or an `rs_instance`.

Direct record and blob results MUST preserve Core disclosure, snapshot, expiry, and revocation semantics. Searches, counts, previews, and summaries MUST satisfy the extended access profile's bounded-presentation rules. Error results MUST respect the same disclosure boundary.

Actions and their responses MUST follow Core's [existing-permissions and action-result rules](spec-core#existing-permissions), including its limited action-receipt allowance. This profile adds no action-permission vocabulary.

## 4. Implementation guidance (informative)

An MCP endpoint can use one ordinary grant; owner selection and grant packages are optional. Using those features requires client support for their authorization requests and complete grant results. Ordinary OAuth redirect support alone does not establish that compatibility.

Some MCP SDKs discard unfamiliar token-response fields by default. Implementers should verify that their client preserves and inspects PDPP's complete authorization result, including on refresh. SDK customization or a grant-aware client may be necessary.

Surveyed MCP clients hold one token per configured server and overwrite it on refresh. A package therefore fits their token storage: the client keeps one token and passes `grant_id` as an ordinary tool argument. The same clients pass a tool result with `isError: true` to the model without retrying or re-authorizing, while several treat HTTP 403 with `insufficient_scope` as a trigger for step-up authorization. For that reason an inactive child is a tool result and not a 403 challenge. Some clients show `isError` results to the model as plain content, so the text of the result has to explain itself. The survey shows compatibility of token storage and tool errors only. It does not show a complete conforming journey: request construction and inspection of the complete result still need PDPP-aware client support. Loss of the last child makes the token inactive, and the resulting 401 can start the host's authorization handling.

Tool names and schemas remain deployment choices. This profile supplies a grant-enforcement claim, not a shared tool vocabulary or a guarantee of complete platform-data coverage. Applicable Core conformance remains required.
