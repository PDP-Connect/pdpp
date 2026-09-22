// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Authorization Server conformance cases against Core Section 9 "Authorization
// Server conformance".
//
// Most AS requirements govern the consent surface — what a user is shown, what
// the server retains while obtaining approval — and are not reachable from a
// client's side of the wire. The ones here are the exceptions: an AS that
// implements RFC 7662 introspection exposes the resolved grant, and Section 8
// makes that response the authoritative enforcement context. It is therefore
// testable, and it is worth testing, because the introspection response is what
// every separated resource server enforces from. An AS that issues a correct
// grant but describes it wrongly over introspection causes every downstream RS
// to enforce the wrong thing, and no RS-side test can detect that.
//
// These cases are gated on `separatedDeployment`. A co-located AS+RS may resolve
// the same context through a local equivalent (Core Section 8), in which case
// there is no introspection endpoint to call and the requirement is unsupported
// rather than failed.

import type { TargetAdapter } from "../harness/adapter.ts";
import { grantSchemaViolations } from "../harness/grant-schema.ts";
import { type PdppResponse, request } from "../harness/http.ts";
import { advisory, type ConformanceCase, fail, pass, skip, unsupported } from "../harness/runner.ts";

/** Trailing slash on an issuer path, stripped before the well-known suffix. */
const TRAILING_SLASH = /\/$/;

/** The RFC 7662 + PDPP introspection response shape (Core Section 8). */
interface IntrospectionBody {
  active?: boolean;
  authorization_details?: {
    type?: string;
    access_mode?: string;
    purpose_code?: string;
    source?: { kind?: string; id?: string };
    streams?: {
      name?: string;
      fields?: string[];
      instance_ids?: string[];
      time_constraint?: { field?: string; since?: string; until?: string };
      resources?: string[];
    }[];
  }[];
  client_id?: string;
  exp?: number;
  grant_id?: string;
  pdpp_token_kind?: string;
  subject_id?: string;
}

/**
 * Discover the introspection endpoint from RFC 8414 authorization server
 * metadata rather than assuming a path.
 *
 * RFC 7662 fixes no location, and RFC 8414 exists so a caller does not have to
 * guess: the reference implementation publishes `/introspect`, while a suite
 * assuming `/oauth/introspect` would report every introspection requirement as
 * untested against a perfectly conforming server. Guessing a path is testing our
 * own convention, which is the same defect the query-base assumption was.
 */
async function discoverIntrospectionEndpoint(asBaseUrl: string): Promise<string | null> {
  const metadata = await fetchAsMetadata(asBaseUrl);
  if (metadata.status !== 200) {
    return null;
  }
  const endpoint = (metadata.json as { introspection_endpoint?: unknown } | undefined)?.introspection_endpoint;
  return typeof endpoint === "string" && endpoint.length > 0 ? endpoint : null;
}

/**
 * The AS's RFC 8414 metadata document, looked for where RFC 8414 §3 puts it.
 *
 * The rule is not "append the well-known path to the base URL". For an issuer
 * carrying a path component, §3 inserts the well-known segment BETWEEN the host
 * and that path — `https://host/.well-known/oauth-authorization-server/tenant`,
 * not `https://host/tenant/.well-known/...`. A suite that only probed the bare
 * host URL could not find the document of any AS mounted under a prefix, and
 * would report it as publishing no metadata at all. That is not a hypothetical:
 * it is why the Vana target's AS-3 cases skipped while the server was serving
 * the document the whole time.
 *
 * The bare form is tried too, because it is the §3 answer for an issuer with no
 * path, which is the more common deployment.
 */
async function fetchAsMetadata(asBaseUrl: string): Promise<PdppResponse> {
  const { origin, pathname } = new URL(asBaseUrl);
  const issuerPath = pathname.replace(TRAILING_SLASH, "");
  const wellKnown = "/.well-known/oauth-authorization-server";

  // Probed in order, not in parallel: the path-aware form is the RFC 8414
  // answer for an issuer WITH a path, and a deployment may legitimately serve
  // a different authority's document at the bare URL. Asking for both at once
  // would race two different authorization servers' metadata.
  if (issuerPath) {
    const pathAware = await request(origin, `${wellKnown}${issuerPath}`);
    if (pathAware.status === 200) {
      return pathAware;
    }
  }
  return await request(origin, wellKnown);
}

type IntrospectedStream = NonNullable<
  NonNullable<IntrospectionBody["authorization_details"]>[number]["streams"]
>[number];

/**
 * Validate one StreamGrant against Section 7's StreamGrant field table.
 * Returns a failure message, or null if the stream conforms.
 */
function streamGrantSchemaViolation(s: IntrospectedStream): string | null {
  if (typeof s.name !== "string" || s.name.length === 0 || s.name.includes("*")) {
    return `Stream name ${JSON.stringify(s.name)} is absent or still a wildcard. Section 7's StreamGrant table requires \`name\` to be a concrete, non-wildcard string in an issued grant.`;
  }
  if (!Array.isArray(s.instance_ids) || s.instance_ids.length === 0) {
    return `Stream "${s.name}" carries no resolved \`instance_ids\`. Section 7's StreamGrant table requires a non-empty, unique instance-handle list in an issued grant — an empty list means fan-in was never resolved.`;
  }
  if (new Set(s.instance_ids).size !== s.instance_ids.length) {
    return `Stream "${s.name}" carries duplicate \`instance_ids\`. Section 7 requires unique instance handles.`;
  }
  if (!Array.isArray(s.fields) || s.fields.length === 0) {
    return `Stream "${s.name}" carries no resolved fields allowlist. The RS enforces the fields list and cannot reconstruct it, so an empty list is an authorization defect rather than an unrestricted grant.`;
  }
  if (s.fields.includes("*")) {
    return `Stream "${s.name}" carries a wildcard in its fields allowlist. Section 7 requires fields to be expanded before issuance.`;
  }
  if (s.time_constraint !== undefined) {
    const tc = s.time_constraint;
    if (typeof tc.field !== "string" || tc.field.length === 0) {
      return `Stream "${s.name}" carries a \`time_constraint\` with no \`field\`. Section 7 requires \`field\` whenever \`time_constraint\` is present.`;
    }
    if (tc.since === undefined && tc.until === undefined) {
      return `Stream "${s.name}" carries a \`time_constraint\` with neither \`since\` nor \`until\`. Section 7 requires at least one bound to be present.`;
    }
  }
  if (s.resources !== undefined && (!Array.isArray(s.resources) || s.resources.length === 0)) {
    return `Stream "${s.name}" carries a \`resources\` field that is present but not a non-empty array. Section 7 says \`resources\`, when present, is a non-empty authorized-record-id list; absent means all records.`;
  }
  return null;
}

/**
 * Introspect a token by whichever route this deployment actually answers on.
 *
 * Discovering an `introspection_endpoint` proves the AS publishes one; it does
 * NOT prove the suite holds credentials that endpoint accepts. Core Section 8
 * lets a co-located deployment authenticate its local-equivalent introspection
 * route with the same owner credential it uses elsewhere, which is a different
 * authentication model from the RFC 7662 client-credential Basic auth
 * `introspectionCredentials` carries.
 *
 * So a 401 from the discovered endpoint is answered by trying the adapter's
 * co-located hook rather than reported as a failure. Treating it as one would
 * publish a finding against a server that introspects correctly and merely
 * authenticates the way its topology allows -- which is exactly what happened
 * the first time discovery started succeeding against the Vana target.
 *
 * Only an AUTHENTICATION refusal falls back. Any other status is the endpoint's
 * real answer about the token and is returned for the case to judge.
 */
async function introspectByAnyRoute(
  adapter: TargetAdapter,
  accessToken: string
): Promise<PdppResponse | null | undefined> {
  const endpoint = adapter.authorizationServerUrl
    ? await discoverIntrospectionEndpoint(adapter.authorizationServerUrl)
    : null;
  if (!endpoint) {
    return await adapter.coLocatedIntrospect?.(accessToken);
  }
  const response = await introspect(endpoint, accessToken, adapter.introspectionCredentials);
  if (response.status !== 401 && response.status !== 403) {
    return response;
  }
  return (await adapter.coLocatedIntrospect?.(accessToken)) ?? response;
}

/**
 * Ask the AS about a token, at the endpoint its metadata advertises,
 * authenticating as a resource server would (RFC 7662 Section 2.1).
 */
async function introspect(
  endpoint: string,
  token: string,
  credentials?: { readonly clientId: string; readonly clientSecret: string }
) {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (credentials) {
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  }
  return await request(endpoint, "", {
    method: "POST",
    headers,
    body: `token=${encodeURIComponent(token)}`,
  });
}

/**
 * The granted (stream, fields) pairs of an authorization_details array, as a
 * stable comparable string.
 *
 * Normalized — streams and fields sorted — because neither RFC 9396 nor Core
 * fixes an ordering for either, so two surfaces listing the same grant in
 * different orders are reporting the same thing. Comparing raw documents would
 * report an ordering difference as a conformance failure.
 */
function grantedStreamFields(details: readonly unknown[]): string {
  const streams = details.flatMap((detail) => {
    const entry = (detail as { streams?: unknown }).streams;
    return Array.isArray(entry) ? entry : [];
  });
  return JSON.stringify(
    streams
      .map((s) => {
        const stream = s as { name?: unknown; fields?: unknown };
        const fields = Array.isArray(stream.fields)
          ? [...stream.fields].map(String).sort((a, b) => a.localeCompare(b))
          : [];
        return { name: String(stream.name), fields };
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  );
}

export const AUTHORIZATION_SERVER_CASES: readonly ConformanceCase[] = [
  // ---------------------------------------------------------------- AS-9 ---
  // AS-9 is `applicability: "always"` (grant-bound tokens with PDPP extension
  // fields apply to every AS, co-located or separated); it is only this case's
  // MECHANISM — RFC 7662 introspection — that a co-located AS may not expose,
  // per Core Section 8's local-equivalent allowance. So the absence of an
  // introspection endpoint is missing evidence (`skip`), not an inapplicable
  // requirement (`unsupported`/`appliesWhen`): the obligation still binds a
  // co-located AS, this suite just has no hook to observe it there yet.
  {
    caseId: "AS-9/introspection-carries-pdpp-extensions",
    requirementId: "AS-9",
    assertion:
      "Introspection of an active client token reports active, pdpp_token_kind client, and the bound grant_id.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      const response = await introspectByAnyRoute(adapter, grant.accessToken);
      if (!response) {
        return skip(
          "AS-9 applies to this target regardless of topology, but it publishes no RFC 8414 introspection_endpoint and the adapter names no known co-located equivalent, so this suite has no mechanism to observe grant-bound token claims here. Missing evidence, not an inapplicable requirement."
        );
      }
      if (response.status !== 200) {
        return fail(`Expected 200 from the introspection endpoint, got ${response.status}.`, [response.evidence]);
      }
      const body = response.json as IntrospectionBody | undefined;
      if (body?.active !== true) {
        return fail("Introspection reported an active token as inactive.", [response.evidence]);
      }
      if (body.pdpp_token_kind !== "client") {
        return fail(
          `Expected pdpp_token_kind "client", got ${JSON.stringify(body.pdpp_token_kind)}. Section 8 requires the RS to determine token kind solely from this response.`,
          [response.evidence]
        );
      }
      if (typeof body.subject_id !== "string" || typeof body.client_id !== "string") {
        return fail("Client token context must include string subject_id and client_id fields (Core Section 8).", [
          response.evidence,
        ]);
      }
      if (body.grant_id !== grant.grantId) {
        return fail(
          `Introspection reported grant_id ${JSON.stringify(body.grant_id)} for a token bound to grant ${grant.grantId}. Section 9 item 9 requires access tokens to be bound to a specific grant.`,
          [response.evidence]
        );
      }
      return pass([response.evidence]);
    },
  },

  // ---------------------------------------------------------------- AS-3 ---
  // Section 9 item 3 requires an issued grant to conform to the Section 7
  // field tables (`#grant`). This case is honest about a real observability
  // ceiling: RFC 9396 `authorization_details` is a deliberately narrower
  // projection of the full grant, not the grant itself. The reference
  // implementation's own `toAuthorizationDetail` (co-located Vana adapter
  // path) drops `version`, `grant_id`, `issued_at`, `subject`, `client`,
  // `source_declaration`, `retention`, `expires_at`, and `selection_preset`
  // deliberately (`client_claims`/`retention` are policy metadata Section 6/7
  // keep out of RS enforcement context) — and the flat `grant_id`/`client_id`/
  // `subject_id` introspection carries live outside `authorization_details`,
  // in a different shape (`client.client_id`, `subject.id`) than the Section 7
  // grant table. So this case validates every StreamGrant sub-field the
  // projection DOES carry (`name`, `instance_ids`, `fields`, `time_constraint`,
  // `resources` — Section 7's StreamGrant table) plus the detail-level fields it
  // carries (`source`, `purpose_code`, `access_mode`). It does not claim full
  // Section 7 schema coverage; the sibling
  // `AS-3/issued-grant-artifact-matches-section-7-schema` case takes the whole
  // grant when a target's approval surface returns one.
  // AS-3 is `applicability: "always"` (every grant, co-located or separated,
  // must conform to the Section 7 grant schema); only this case's MECHANISM —
  // reading the resolved grant back over RFC 7662 introspection — is
  // separated-deployment-specific. A co-located AS without an introspection
  // endpoint is missing evidence (`skip`), not exempt from the requirement, so
  // this case must not gate on `separatedDeployment` via `appliesWhen`.
  {
    caseId: "AS-3/resolved-grant-matches-observable-schema-fields",
    requirementId: "AS-3",
    assertion:
      "Every grant field observable through introspection (the RFC 9396 detail's source/purpose_code/access_mode, and each StreamGrant's name/instance_ids/fields/time_constraint/resources) matches Section 7's field tables. Top-level fields the projection never carries (version, grant_id, issued_at, subject, client, source_declaration, retention, expires_at) are reported as unobserved, not passed.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      const response = await introspectByAnyRoute(adapter, grant.accessToken);
      if (!response) {
        return skip(
          "AS-3 applies to this target regardless of topology, but it publishes no RFC 8414 introspection_endpoint and the adapter names no known co-located equivalent, so this suite has no mechanism to observe the resolved grant here. Missing evidence, not an inapplicable requirement."
        );
      }
      if (response.status !== 200) {
        return fail(`Expected 200 from the introspection endpoint, got ${response.status}.`, [response.evidence]);
      }
      const body = response.json as IntrospectionBody | undefined;
      const details = body?.authorization_details;
      if (!Array.isArray(details) || details.length === 0) {
        return fail(
          "Introspection of a client token carried no authorization_details. Section 8 requires the response to contain the complete context needed to enforce the request.",
          [response.evidence]
        );
      }
      const [detail] = details;
      if (detail?.type !== "https://pdpp.dev/data-access") {
        return fail(
          `Expected authorization_details type "https://pdpp.dev/data-access", got ${JSON.stringify(detail?.type)}.`,
          [response.evidence]
        );
      }
      if (typeof detail.purpose_code !== "string" || detail.purpose_code.length === 0) {
        return fail(
          `Section 7 requires \`purpose_code\` as a required URI. Got ${JSON.stringify(detail.purpose_code)}.`,
          [response.evidence]
        );
      }
      if (detail.access_mode !== "single_use" && detail.access_mode !== "continuous") {
        return fail(
          `Section 7 requires \`access_mode\` to be exactly "single_use" or "continuous". Got ${JSON.stringify(detail.access_mode)}.`,
          [response.evidence]
        );
      }
      if (typeof detail.source?.id !== "string" || detail.source.id.length === 0) {
        return fail(
          `Section 7 requires \`source\` as \`{ kind, id }\` retained from the accepted SourceDeclaration. Got ${JSON.stringify(detail.source)}.`,
          [response.evidence]
        );
      }
      const grantStreams = detail.streams ?? [];
      if (grantStreams.length === 0) {
        return fail("The resolved authorization detail names no streams.", [response.evidence]);
      }
      for (const s of grantStreams) {
        const violation = streamGrantSchemaViolation(s);
        if (violation) {
          return fail(violation, [response.evidence]);
        }
      }
      return pass([response.evidence]);
    },
  },

  // ---------------------------------------------------------------- AS-8 ---
  // Two normative levels, kept apart on purpose.
  //
  // The MUST: Core Section 9 AS item 8 requires revocation to be "reflected
  // immediately in introspection responses (`active: false`)". That is the whole
  // of what Core pins here, and failing it is a conformance failure.
  //
  // The SHOULD: RFC 7662 Section 2.2 says an authorization server "SHOULD NOT"
  // include extra information about an inactive token. Core does not restate or
  // strengthen that clause — no text in spec-core.md raises it to a MUST the way
  // Section 8 does for `error="invalid_token"`. So a target that returns
  // `active: false` while still echoing the subject or grant is CONFORMANT and is
  // reported `advisory`, not `fail`. Calling it a failed MUST would mean telling
  // an implementer their conforming server is non-conformant, on a clause the
  // specification never made binding.
  // AS-8 is `applicability: "always"`: Section 9 item 8's obligation to reflect
  // revocation immediately applies to every AS. Item 8's own text names
  // "introspection responses" as the mechanism, but unlike item 18 ("For a
  // separated AS and RS...") it carries no topology qualifier, and Core Section
  // 8 lets a co-located AS satisfy the same obligation through a local
  // equivalent. So a missing introspection endpoint here is missing evidence
  // (`skip`), not grounds to mark the requirement inapplicable.
  {
    caseId: "AS-8/revoked-token-introspects-inactive",
    requirementId: "AS-8",
    assertion:
      "After revocation, introspection reports active false (MUST); extra disclosure on the inactive response is reported as advisory (RFC 7662 SHOULD NOT).",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }

      // Establish that introspection reports this token active first; otherwise a
      // later active:false proves nothing about revocation. Like AS-9, a
      // co-located AS with no RFC 8414 metadata may still expose the same
      // obligation through `coLocatedIntrospect` (Core Section 8's local
      // equivalent), so try that before giving up on missing evidence.
      const doIntrospect = (token: string) => introspectByAnyRoute(adapter, token);

      const before = await doIntrospect(grant.accessToken);
      if (!before) {
        return skip(
          "AS-8 applies to this target regardless of topology, but it publishes no RFC 8414 introspection_endpoint and the adapter names no known co-located equivalent, so this suite has no mechanism to observe revocation reflection here. Missing evidence, not an inapplicable requirement."
        );
      }
      if (before.status !== 200 || (before.json as IntrospectionBody | undefined)?.active !== true) {
        return skip("Introspection did not report the fresh token as active, so revocation cannot be isolated.");
      }

      await adapter.revokeGrant(grant.grantId);

      const after = await doIntrospect(grant.accessToken);
      if (!after) {
        return skip(
          "The adapter could not observe introspection after revocation; the token state remains unverified."
        );
      }
      if (after.status !== 200) {
        return fail(`Expected 200 from introspection after revocation, got ${after.status}.`, [
          before.evidence,
          after.evidence,
        ]);
      }
      const body = after.json as IntrospectionBody | undefined;
      if (body?.active !== false) {
        return fail(
          "Introspection still reports a revoked token as active. Section 9 item 8 requires revocation to be reflected immediately in introspection responses.",
          [before.evidence, after.evidence]
        );
      }
      // The MUST is satisfied at this point: active is false. Anything below is
      // a recommendation, and is reported at that level.
      const disclosed = (["subject_id", "client_id", "grant_id", "authorization_details"] as const).filter(
        (key) => body[key] !== undefined
      );
      if (disclosed.length > 0) {
        return advisory(
          `Revocation is correctly reflected (active: false), which is what Core Section 9 AS item 8 requires. The inactive introspection response additionally disclosed ${disclosed.join(", ")}. RFC 7662 Section 2.2 says an authorization server SHOULD NOT include that information, and Core does not raise that clause to a MUST, so this is a recommendation rather than a conformance failure. A holder of a revoked token string can still learn whose it was and what it covered.`,
          [before.evidence, after.evidence]
        );
      }
      return pass([before.evidence, after.evidence]);
    },
  },

  // --------------------------------------------------------------- AS-15 ---
  // Section 9 AS item 15: the AS "binds exact resolved instances and all final
  // decision fields to an immutable review revision" and "rejects stale approval
  // if eligibility or the reviewed revision changes before approval".
  //
  // The half testable from outside is the binding itself: an approval carrying a
  // revision the server never issued must be refused. A server that ignores the
  // revision cannot detect a stale approval either, because it has nothing to
  // compare against — so this case is the precondition for the requirement's
  // whole purpose, which is that a user approves exactly what they reviewed.
  {
    caseId: "AS-15/approval-requires-the-issued-revision",
    requirementId: "AS-15",
    assertion: "An approval carrying a review revision the server never issued is refused.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      if (!adapter.stageApproval) {
        return skip(
          "The adapter cannot stage an authorization request short of approval, so revision binding is not observable. This needs a harness hook, not a different assertion."
        );
      }
      const staged = await adapter.stageApproval({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!staged) {
        return skip("The target could not stage an authorization request.");
      }
      if (!staged.reviewRevision) {
        return skip(
          "The target publishes no review revision or digest, so there is no binding to test. Section 9 item 15 assumes one exists."
        );
      }

      const forged = await staged.approve("pdpp-conformance-never-issued-revision");
      if (forged) {
        return fail(
          `An approval carrying a revision the server never issued was accepted and produced grant ${forged.grantId}. Section 9 AS item 15 requires the final decision to be bound to an immutable review revision; a server that does not check it cannot detect a stale approval either, so a user can approve something other than what they reviewed.`
        );
      }

      // Positive control: the real revision must still work, or the refusal
      // above would prove only that approval is broken.
      const genuine = await staged.approve(staged.reviewRevision);
      if (!genuine) {
        return skip(
          "The forged revision was refused, but so was the genuine one, so this run cannot show the server distinguishes them."
        );
      }
      return pass();
    },
  },

  // --------------------------------------------------------------- AS-19 ---
  // Section 9 AS item 19: each OAuth authorization code is consumed atomically
  // on its first successful redemption, and every later redemption at the
  // TOKEN endpoint is rejected with `invalid_grant`. That is a claim about
  // code redemption, not about approval idempotency — a second `approve` of
  // the same staged request is a different step (the review/consent screen),
  // and a server that merely memoizes approval while still letting the code be
  // redeemed twice at `/token` violates this item while passing an
  // approval-only check. The case therefore drives a real second redemption of
  // the SAME code with the SAME PKCE verifier, through `replayLastCode`, which
  // keeps the code itself private to the adapter.
  {
    caseId: "AS-19/authorization-code-redemption-is-not-replayable",
    requirementId: "AS-19",
    assertion:
      "Replaying the same authorization code and PKCE verifier at the token endpoint is refused with invalid_grant.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      if (!adapter.stageApproval) {
        return skip(
          "The adapter cannot stage an authorization request short of approval, so code redemption is not observable."
        );
      }
      const staged = await adapter.stageApproval({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!staged) {
        return skip("The target could not stage an authorization request.");
      }
      if (!staged.replayLastCode) {
        return skip(
          "The adapter has no replayLastCode hook, so a genuine second token-endpoint redemption of the same code cannot be observed."
        );
      }

      const first = await staged.approve(staged.reviewRevision);
      if (!first) {
        return skip("The first approval did not succeed, so code redemption cannot be isolated.");
      }

      const replayed = await staged.replayLastCode();
      if (!replayed) {
        return skip(
          "The replay attempt did not reach the token endpoint intelligibly (transport failure), so it cannot be distinguished from a correct refusal."
        );
      }
      if (replayed.accessToken) {
        return fail(
          `Replaying the same authorization code at the token endpoint issued a further access token (grant ${first.grantId}) instead of being refused. Section 9 AS item 19 requires the code to be consumed atomically on first redemption and every later redemption rejected with invalid_grant — an attacker who observes one authorization code can otherwise redeem it again for their own live token, even when the grant id matches the legitimate one.`
        );
      }
      if (!(replayed.status === 400 && replayed.errorCode === "invalid_grant")) {
        return fail(
          `Replaying the same authorization code at the token endpoint returned status ${replayed.status}${replayed.errorCode ? ` with error "${replayed.errorCode}"` : " with no machine-readable error code"}, not a structured 400 invalid_grant refusal. Section 9 AS item 19 requires that exact refusal so a client can distinguish code replay from any other failure.`
        );
      }
      return pass();
    },
  },

  // --------------------------------------------------------------- AS-18 ---
  {
    caseId: "AS-18/introspection-requires-authentication",
    requirementId: "AS-18",
    appliesWhen: (adapter) => adapter.capabilities.separatedDeployment,
    assertion: "The introspection endpoint refuses an unauthenticated caller.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!grant) {
        return skip("The target could not issue a grant for a seeded stream.");
      }
      // Deliberately no credential: RFC 7662 requires the AS to authenticate the
      // caller. An open introspection endpoint turns any leaked token string into
      // a lookup oracle for the grant it carries.
      const endpoint = adapter.authorizationServerUrl
        ? await discoverIntrospectionEndpoint(adapter.authorizationServerUrl)
        : null;
      if (!endpoint) {
        return skip(
          "The target declares a separated deployment but publishes no introspection_endpoint in its RFC 8414 authorization server metadata."
        );
      }
      // Deliberately no credential: RFC 7662 requires the AS to authenticate the
      // caller. An open endpoint turns any leaked token into a lookup oracle.
      const response = await request(endpoint, "", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(grant.accessToken)}`,
      });
      if (response.status === 401 || response.status === 403) {
        return pass([response.evidence]);
      }
      return fail(
        `An unauthenticated introspection call returned ${response.status} rather than 401 or 403. Section 9 item 18 requires the AS to authenticate the resource server at the introspection endpoint.`,
        [response.evidence]
      );
    },
  },

  // --------------------------------------------------------------- AS-14 ---
  // Section 9 AS item 14 / #ai-training-consent: the sole purpose code with a
  // protocol-level (not merely advisory) consent requirement. An AS MUST
  // obtain explicit affirmative consent before issuing ANY grant carrying
  // `purpose_code: https://pdpp.dev/purpose/ai_training`; every other purpose
  // code's consent properties remain advisory. The negative control below must
  // therefore differ from the positive control ONLY in the consent flag, on
  // the exact normative purpose code, so a pass cannot be read as "this AS
  // requires extra consent for purposes in general".
  {
    caseId: "AS-14/explicit-consent-required-for-ai-training",
    requirementId: "AS-14",
    assertion:
      "An otherwise permitted ai_training request succeeds with explicit consent and returns a structured denial without it.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      if (!adapter.stageApproval) {
        return skip(
          "The adapter cannot stage an authorization request short of approval, so this suite has no hook to submit explicit_ai_training_consent separately from approval. This is a harness-coverage gap, not a target defect."
        );
      }

      const grantRequest = {
        streams: [{ name: stream.name, fields: [...stream.fields] }],
        purposeCode: "https://pdpp.dev/purpose/ai_training",
      };

      // Negative control first: ordinary approval, with no explicit consent
      // signal at all, must not issue a grant carrying this purpose code.
      const stagedForDenial = await adapter.stageApproval(grantRequest);
      if (!stagedForDenial) {
        return skip("The target could not stage an ai_training authorization request.");
      }
      const denied = await stagedForDenial.approve(stagedForDenial.reviewRevision);
      if (denied) {
        return fail(
          `An ai_training grant (${denied.grantId}) was issued by an ordinary approval that gave no explicit affirmative consent. Section 9 AS item 14 requires explicit affirmative consent before issuing ANY grant with purpose_code https://pdpp.dev/purpose/ai_training — this is the sole purpose code with a protocol-level consent requirement, so a bare approval must not be sufficient for it.`
        );
      }
      const deniedError = stagedForDenial.lastApproveError?.();
      if (!deniedError || deniedError.status < 400 || deniedError.status >= 500 || !deniedError.errorCode) {
        return skip(
          "The approval returned no grant, but the adapter supplied no structured client-error denial. Consent enforcement cannot be distinguished from transport or harness failure."
        );
      }

      // Positive control: the identical request shape, differing only in the
      // consent flag, must succeed. Without this, a target that refuses
      // ai_training grants unconditionally would pass the negative check
      // vacuously.
      const stagedForApproval = await adapter.stageApproval(grantRequest);
      if (!stagedForApproval) {
        return skip("The target could not stage a second ai_training authorization request.");
      }
      const approved = await stagedForApproval.approve(stagedForApproval.reviewRevision, true);
      if (!approved) {
        const approvedError = stagedForApproval.lastApproveError?.();
        return skip(
          `The positive control could not obtain an otherwise permitted ai_training grant with explicit_ai_training_consent given${
            approvedError ? ` (${approvedError.status} ${approvedError.errorCode ?? "no error code"})` : ""
          }. Explicit consent is necessary, but does not override other issuance policies; this fixture cannot isolate the consent gate.`
        );
      }
      return pass();
    },
  },

  // ----------------------------------------------------------- v0.2/6.4-4 ---
  // PR #1, "Limits and owner choices": "The AS MUST refuse issuance when the
  // owner approves no streams." No Section 9 item claims this clause — it is
  // new in the proposal, with no v0.1 counterpart to supersede — so this case
  // is filed under AS-4 as the nearest thematic item (request resolution
  // before issuance) rather than one that actually requires it.
  //
  // The request names exactly one stream, marked `necessity: "optional"` so
  // its decline is legal under the owner's discretion clause two sentences
  // earlier ("MAY let the owner remove optional streams") rather than
  // colliding with the separate required-stream-refusal rule. Declining the
  // ONLY stream is therefore "the owner approves no streams" by construction,
  // not a side effect of some other refusal.
  //
  // POSITIVE CONTROL FIRST, same request shape approved without any decline:
  // without it, a target that refuses every v0.2 approval — including one
  // that never implements owner narrowing — satisfies the refusal check
  // vacuously and reports conformant while unable to grant anything.
  {
    caseId: "AS-4/v0.2-refuse-issuance-when-owner-approves-no-streams",
    requirementId: "AS-4",
    assertion: "A v0.2 approval where the owner declines every requested stream is refused, not issued empty.",
    async run({ adapter, streams }) {
      const stream = streams.find((s) => s.fields.length > 0);
      if (!stream) {
        return skip("No seeded stream declares a field, so a single-stream optional request cannot be built.");
      }
      if (!adapter.stageApproval) {
        return skip(
          "The adapter cannot stage an authorization request short of approval, so owner choices cannot be attached separately from approval. This is a harness-coverage gap, not a target defect."
        );
      }

      const grantRequest = {
        specVersion: "0.2" as const,
        streams: [{ name: stream.name, fields: [...stream.fields], necessity: "optional" as const }],
      };

      const stagedForControl = await adapter.stageApproval(grantRequest);
      if (!stagedForControl) {
        return skip("The target could not stage a v0.2 authorization request over a single optional stream.");
      }
      const control = await stagedForControl.approve(stagedForControl.reviewRevision);
      if (!control) {
        const controlError = stagedForControl.lastApproveError?.();
        return skip(
          `The positive control — the same request, approved as made, with no decline — could not obtain a grant${
            controlError ? ` (${controlError.status} ${controlError.errorCode ?? "no error code"})` : ""
          }. This target does not grant the request shape the negative below declines, so a refusal there would not be attributable to the decline.`
        );
      }

      // A target may refuse at either boundary: some stage the request and
      // refuse at `approve` (a structured denial), others refuse to stage a
      // request that already resolves to zero streams. Core requires only that
      // ISSUANCE be refused, not which of the two steps does the refusing, so
      // a stage-time null is accepted here as evidence of refusal rather than
      // as missing evidence — unlike the `!stagedForControl` branch above,
      // where a null is ambiguous because the request has not yet been shown
      // to be grantable at all.
      const stagedForDenial = await adapter.stageApproval({
        ...grantRequest,
        ownerChoices: { declineStreams: [stream.name] },
      });
      if (!stagedForDenial) {
        return pass();
      }
      const denied = await stagedForDenial.approve(stagedForDenial.reviewRevision);
      if (denied) {
        return fail(
          `A grant (${denied.grantId}) was issued after the owner declined the request's only stream. PR #1 requires the AS to refuse issuance rather than issue a grant over zero streams — an empty grant is not a smaller version of the request, it is a client credential the client never asked for and cannot use.`
        );
      }
      const deniedError = stagedForDenial.lastApproveError?.();
      if (!deniedError || deniedError.status < 400 || deniedError.status >= 500) {
        return skip(
          "The approval returned no grant, but the adapter supplied no structured client-error denial. Refusal cannot be distinguished from transport or harness failure."
        );
      }
      return pass();
    },
  },

  // ----------------------------------------------------------- v0.2/6.1-1 ---
  // PR #1, "Stream selection parameters": "The AS MUST retain a required
  // stream or refuse authorization." No Section 9 item claims this clause —
  // filed under AS-4 as the nearest thematic item, same convention as
  // v0.2/6.4-4 above.
  //
  // This is 6.4-4's sibling and NOT a duplicate of it: 6.4-4 is about an
  // OPTIONAL stream, where the owner's decline is a choice Core explicitly
  // permits and the only question is whether the AS still issues an empty
  // grant. This clause is about a REQUIRED stream, where the decline itself
  // is the AS's cue to refuse outright — there is no owner discretion to
  // exercise, and a target that lets the owner decline a required stream and
  // issues a grant missing it has silently downgraded the client's floor to
  // optional without saying so.
  //
  // POSITIVE CONTROL FIRST, same shape approved with no decline, for the same
  // reason as 6.4-4: without it a target that refuses every v0.2 approval
  // passes this negative for the wrong reason.
  {
    caseId: "AS-4/v0.2-refuse-issuance-when-required-stream-declined",
    requirementId: "AS-4",
    assertion: "A v0.2 approval where the owner declines a required stream is refused, not issued without it.",
    async run({ adapter, streams }) {
      const stream = streams.find((s) => s.fields.length > 0);
      if (!stream) {
        return skip("No seeded stream declares a field, so a single-stream required request cannot be built.");
      }
      if (!adapter.stageApproval) {
        return skip(
          "The adapter cannot stage an authorization request short of approval, so owner choices cannot be attached separately from approval. This is a harness-coverage gap, not a target defect."
        );
      }

      const grantRequest = {
        specVersion: "0.2" as const,
        streams: [{ name: stream.name, fields: [...stream.fields], necessity: "required" as const }],
      };

      const stagedForControl = await adapter.stageApproval(grantRequest);
      if (!stagedForControl) {
        return skip("The target could not stage a v0.2 authorization request over a single required stream.");
      }
      const control = await stagedForControl.approve(stagedForControl.reviewRevision);
      if (!control) {
        const controlError = stagedForControl.lastApproveError?.();
        return skip(
          `The positive control — the same request, approved as made, with no decline — could not obtain a grant${
            controlError ? ` (${controlError.status} ${controlError.errorCode ?? "no error code"})` : ""
          }. This target does not grant the request shape the negative below declines, so a refusal there would not be attributable to the decline.`
        );
      }

      // A target may refuse at either boundary, same acceptance rule as
      // 6.4-4: Core requires only that issuance be refused.
      const stagedForDenial = await adapter.stageApproval({
        ...grantRequest,
        ownerChoices: { declineStreams: [stream.name] },
      });
      if (!stagedForDenial) {
        return pass();
      }
      const denied = await stagedForDenial.approve(stagedForDenial.reviewRevision);
      if (denied) {
        return fail(
          `A grant (${denied.grantId}) was issued after the owner declined the request's only, required, stream. PR #1 requires the AS to retain a required stream or refuse authorization outright — a grant issued without it means the AS treated a required stream as optional and did not say so.`
        );
      }
      const deniedError = stagedForDenial.lastApproveError?.();
      if (!deniedError || deniedError.status < 400 || deniedError.status >= 500) {
        return skip(
          "The approval returned no grant, but the adapter supplied no structured client-error denial. Refusal cannot be distinguished from transport or harness failure."
        );
      }
      return pass();
    },
  },

  // ---------------------------------------------------------------- AS-3 ---
  // The whole Section 7 grant, when the target's approval surface returns one.
  //
  // The introspection case above can only see the RFC 9396 projection, which
  // structurally omits `version`, `grant_id`, `issued_at`, `subject`, `client`,
  // `source_declaration`, `retention` and `expires_at`. Those rows are half of
  // Section 7's table and Section 9 item 3 requires them, so the projection
  // cannot be the whole oracle. The one boundary that can carry them is the
  // approval response itself, so `IssuedGrant.rawGrant` passes that body through
  // verbatim and this case validates it.
  //
  // Oracle: `grantSchemaViolations`, transcribed from the spec's normative field
  // tables, NOT from any target's validator — an implementation cannot be its
  // own conformance oracle. Its discrimination is proved by the independent
  // mutant matrix in `test/grant-schema-oracle.test.ts`.
  //
  // Scope: the field tables' SHAPE obligations — required rows present, types,
  // enums, exact-key objects, uniqueness, no wildcards. NOT every Section 7
  // semantic obligation. Specifically out of scope, and so still partial for
  // AS-3: ISO 8601 lexical form (the tables say only "ISO 8601"; narrowing that
  // would fail targets for an unwritten rule), whether each field was correctly
  // DERIVED from the selection request / client registration / AS policy, and
  // whether `source_declaration.version` names the snapshot actually consented
  // to. Those need provenance the wire does not carry.
  //
  // No artifact means SKIP (missing evidence), never pass: an adapter that
  // cannot read the grant back must not be scored as if the grant conformed. The
  // adapters deliberately do not synthesize one, because a body rebuilt from
  // `GrantRequest` would echo the suite's own request and this case would be
  // measuring itself. As of personal-server-ts def4ff7 the Vana approval route
  // returns `{ redirect_uri, grant_id }` only (packages/server/src/routes/
  // pdpp-auth.ts), so this case skips against that target.
  {
    caseId: "AS-3/issued-grant-artifact-matches-section-7-schema",
    requirementId: "AS-3",
    assertion:
      "The returned issued grant passes the implemented Section 7 structural checks. URI and temporal syntax, canonical resource keys, nested requester metadata and derivation provenance remain unverified.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] });
      if (!grant) {
        return skip("The target issued no grant, so there is no artifact to validate.");
      }
      if (grant.rawGrant === undefined) {
        return skip(
          "The target's approval response carried no grant artifact, so Section 7's full field tables are unobserved. The suite will not synthesize a grant body from its own request to stand in for one."
        );
      }
      const violations = grantSchemaViolations(grant.rawGrant);
      if (violations.length > 0) {
        return fail(
          `The issued grant artifact violates Section 7's field tables: ${violations
            .map((v) => `${v.path || "<root>"}: ${v.message}`)
            .join(" ")}`
        );
      }
      return pass();
    },
  },

  // ---------------------------------------------------------------- 10.2-4 ---
  // Core Section 10 "Token security": "Every successful OAuth token response
  // that contains an access token or refresh token MUST include
  // `Cache-Control: no-store` and `Pragma: no-cache` before the response is
  // serialized."
  //
  // This is the cheapest MUST in the uncovered set and it stayed uncovered for
  // a structural reason rather than a hard one: every adapter obtains tokens
  // and every adapter threw the response headers away. The obligation is
  // entirely in those headers.
  //
  // Worth testing despite looking clerical. The failure is silent at issuance
  // and the damage is remote: a proxy or browser cache that was never told not
  // to store a credential-bearing response can serve that credential to a later
  // caller, and nothing in the protocol exchange looks wrong at any point.
  {
    caseId: "AS-9/token-response-forbids-caching",
    requirementId: "AS-9",
    assertion:
      "A successful token response carrying an access token includes Cache-Control: no-store and Pragma: no-cache.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] });
      if (!grant) {
        return skip("The target issued no grant, so there is no token response to inspect.");
      }
      const headers = grant.tokenResponseHeaders;
      if (!headers) {
        return skip(
          "The adapter does not surface the token endpoint's response headers (IssuedGrant.tokenResponseHeaders), so this deployment's token response is unobserved. An absent header map is not an absent header, and the suite will not read one as the other."
        );
      }

      const evidence = [
        {
          request: { method: "POST", url: "token endpoint", headers: {} },
          response: { status: 200, headers: { ...headers }, body: "" },
        },
      ];

      // Case-insensitive on the VALUE too: RFC 9111 directives are
      // case-insensitive, and a server sending `No-Store` is conforming. The
      // suite must not report a spelling preference as a spec violation.
      const cacheControl = headers["cache-control"] ?? "";
      const pragma = headers.pragma ?? "";
      const missing: string[] = [];
      if (!cacheControl.toLowerCase().includes("no-store")) {
        missing.push(`Cache-Control: no-store (got ${cacheControl === "" ? "no header" : `"${cacheControl}"`})`);
      }
      if (!pragma.toLowerCase().includes("no-cache")) {
        missing.push(`Pragma: no-cache (got ${pragma === "" ? "no header" : `"${pragma}"`})`);
      }
      if (missing.length > 0) {
        return fail(
          `The successful token response carrying an access token omitted ${missing.join(" and ")}. Core Section 10 "Token security" requires both on every token response that contains an access or refresh token, before the response is serialized. Without them a caching intermediary is entitled to store the credential and serve it to a later caller, which nothing later in the exchange would reveal.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // --------------------------------------------- RFC 9396 Section 7 ---------
  // NOT a Core clause, and deliberately not given one. Core adopts the RFC 9396
  // `authorization_details` envelope by normative reference (Section 2,
  // "Related standards": "PDPP uses the `authorization_details` envelope for
  // selection requests") and describes both the selection request and the
  // introspection response — but never restates RFC 9396 Section 7's
  // token-response obligation:
  //
  //   "the AS MUST return the `authorization_details` as granted in the token
  //    response"  — when the request carried them.
  //
  // So a deployment can satisfy every Core clause in the matrix and still fail
  // an obligation it owes, because Core's own normative reference pulls it in.
  // The matrix enumerates spec-core.md only (see its header section
  // "Obligations from referenced standards"): adding a row here would mean
  // inventing a Core clause id for text Core does not contain, which makes the
  // matrix a worse record rather than a better one. The obligation is tracked
  // on this case instead, which names the standard and section in its own
  // assertion, and rides on AS-9 — the requirement that owns token issuance.
  //
  // Why it matters concretely: a client that cannot read what it was granted
  // from the response that granted it must introspect to find out. On a
  // separated deployment that endpoint authenticates resource servers, not
  // clients, so the client may have no way to ask at all — and is left
  // enforcing its own idea of the grant against a server enforcing another.
  {
    caseId: "AS-9/token-response-carries-granted-authorization-details",
    requirementId: "AS-9",
    assertion:
      "RFC 9396 Section 7 (adopted by Core's Section 2 normative reference, not restated in Core): the token response carries `authorization_details` as granted, agreeing with what introspection reports for the same grant.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const grant = await adapter.issueGrant({ streams: [{ name: stream.name, fields: [...stream.fields] }] });
      if (!grant) {
        return skip("The target issued no grant, so there is no token response to inspect.");
      }
      if (grant.tokenResponseBody === undefined) {
        return skip(
          "The adapter does not surface the token endpoint's response body (IssuedGrant.tokenResponseBody), so this deployment's token response is unobserved. An absent body is not an absent field."
        );
      }

      const tokenDetails = (grant.tokenResponseBody as { authorization_details?: unknown }).authorization_details;
      const evidence = [
        {
          request: { method: "POST", url: "token endpoint", headers: {} },
          response: { status: 200, headers: {}, body: JSON.stringify(grant.tokenResponseBody) },
        },
      ];
      if (!Array.isArray(tokenDetails) || tokenDetails.length === 0) {
        return fail(
          "The token response carried no `authorization_details`. RFC 9396 Section 7 requires the AS to return the authorization_details as granted in the token response when the request carried them, and Core adopts that envelope by normative reference. Without it a client cannot learn what it was actually granted from the response that granted it — it must introspect, which on a separated deployment is an endpoint authenticated for resource servers rather than for clients.",
          evidence
        );
      }

      // The comparison half. "As granted" is the obligation, so a response
      // carrying SOMETHING under the right key is not enough: it has to agree
      // with what this AS itself says the grant is. Introspection is the only
      // other place that answer is published, so it is the oracle — and a
      // target with no introspection surface reports skip rather than letting
      // the presence check alone stand in for the clause.
      const introspection = await introspectByAnyRoute(adapter, grant.accessToken);
      if (introspection?.status !== 200) {
        return skip(
          'The token response carries authorization_details, but this deployment publishes no introspection result to compare them against, so "as granted" is unverified. The presence check alone is not the obligation.'
        );
      }
      evidence.push(introspection.evidence);
      const introspected = (introspection.json as IntrospectionBody | undefined)?.authorization_details;
      if (!Array.isArray(introspected) || introspected.length === 0) {
        return skip("Introspection reported no authorization_details for this grant, so there is nothing to compare.");
      }

      // Compared on the facts that decide enforcement — the granted streams and
      // their fields — rather than by deep-equality of the two documents. Core
      // fixes no requirement that the two surfaces serialize identically, and
      // asserting that would test this suite's assumption rather than the
      // standard's obligation.
      const granted = grantedStreamFields(tokenDetails);
      const reported = grantedStreamFields(introspected);
      if (granted !== reported) {
        return fail(
          `The token response's authorization_details do not match what introspection reports for the same grant. Token response granted ${granted}; introspection reports ${reported}. RFC 9396 Section 7 requires the token response to carry the authorization_details AS GRANTED — a response carrying some other shape tells the client it holds an authorization it does not, and the client then enforces one grant while the resource server enforces another.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 6.2-2 ---
  // Pre-registered public client discovery. No Section 9 item covers it, so it
  // rides on AS-7, the requirement that owns requester identity metadata.
  //
  // The clause is conditional on the AS advertising `pre_registered_public` in
  // `pdpp_registration_modes_supported`, and a target that does not advertise
  // it reports `unsupported` — the obligation genuinely does not bind it.
  //
  // What makes this worth a case: the endpoint is unauthenticated by design,
  // because its whole purpose is to be discovered by agents and third-party
  // clients without an out-of-band walkthrough. Anything published here is
  // published to everyone. Core lists exactly what an entry may carry and names
  // four categories it MUST NOT — and the failure is not a leaked credential
  // that something downstream would reject, but a deployment's private
  // registration state readable by anyone who fetches a well-known document.
  {
    caseId: "AS-7/pre-registered-public-clients-carry-no-private-state",
    requirementId: "AS-7",
    assertion:
      "When the AS advertises pre_registered_public, every published entry carries only client_id, client_name and token_endpoint_auth_method — no secrets, tokens, owner-scoped clients, dynamically registered clients, or private registration state.",
    async run({ adapter }) {
      const asUrl = adapter.authorizationServerUrl;
      if (!asUrl) {
        return skip(
          "The adapter publishes no authorizationServerUrl, so the RFC 8414 metadata document cannot be located and the registration modes this clause is conditional on are unobserved."
        );
      }
      const metadata = await fetchAsMetadata(asUrl);
      if (metadata.status !== 200) {
        return skip(
          `The RFC 8414 metadata document returned ${metadata.status}, so whether this AS advertises pre_registered_public is unknown.`
        );
      }
      const body = metadata.json as
        | {
            pdpp_registration_modes_supported?: unknown;
            pdpp_pre_registered_public_clients?: unknown;
          }
        | undefined;
      const modes = body?.pdpp_registration_modes_supported;
      const advertises = Array.isArray(modes) && modes.includes("pre_registered_public");
      if (!advertises) {
        return unsupported(
          "This AS does not advertise `pre_registered_public` in `pdpp_registration_modes_supported`, so the obligations on `pdpp_pre_registered_public_clients` do not bind it."
        );
      }

      const entries = body?.pdpp_pre_registered_public_clients;
      const evidence = [metadata.evidence];
      if (!Array.isArray(entries)) {
        return fail(
          "The AS advertises `pre_registered_public` but publishes no `pdpp_pre_registered_public_clients` array. Core: when the mode is advertised, the reference publishes that field so agents and third-party clients can discover usable `client_id` values without an out-of-band walkthrough.",
          evidence
        );
      }

      // Checked as an allowlist, not a denylist of known-bad key names. Core
      // names the three fields an entry contains, so anything else is either
      // private state or unspecified — and a denylist would only ever catch the
      // leak shapes whoever wrote it thought of.
      const violations: string[] = [];
      for (const [index, entry] of entries.entries()) {
        if (typeof entry !== "object" || entry === null) {
          violations.push(`entry ${index} is not an object`);
          continue;
        }
        const extra = Object.keys(entry).filter((key) => !ALLOWED_PUBLIC_CLIENT_KEYS.has(key));
        if (extra.length > 0) {
          violations.push(`entry ${index} (${describeEntry(entry)}) carries ${extra.join(", ")}`);
        }
      }
      if (violations.length > 0) {
        return fail(
          `The published pre-registered public client entries carry fields outside the three Core defines (${[...ALLOWED_PUBLIC_CLIENT_KEYS].join(", ")}): ${violations.join("; ")}. Core: "These entries are public client metadata, not authority to access data ... the field MUST NOT contain secrets, access tokens, owner-scoped clients, dynamically registered clients, or private registration state." This document is unauthenticated by design, so whatever it carries is readable by anyone.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },
];

/** The three fields Core says a `pdpp_pre_registered_public_clients` entry contains. */
const ALLOWED_PUBLIC_CLIENT_KEYS: ReadonlySet<string> = new Set([
  "client_id",
  "client_name",
  "token_endpoint_auth_method",
]);

/** A published entry's identity, for naming it in a failure without dumping it. */
function describeEntry(entry: object): string {
  const id = (entry as { client_id?: unknown }).client_id;
  return typeof id === "string" ? id : "no client_id";
}
