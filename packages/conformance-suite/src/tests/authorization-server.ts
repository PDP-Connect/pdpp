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

import { request } from "../harness/http.ts";
import { advisory, type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";

/** The RFC 7662 + PDPP introspection response shape (Core Section 8). */
interface IntrospectionBody {
  active?: boolean;
  authorization_details?: {
    type?: string;
    streams?: { name?: string; fields?: string[]; instance_ids?: string[] }[];
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
  const metadata = await request(asBaseUrl, "/.well-known/oauth-authorization-server");
  if (metadata.status !== 200) {
    return null;
  }
  const endpoint = (metadata.json as { introspection_endpoint?: unknown } | undefined)?.introspection_endpoint;
  return typeof endpoint === "string" && endpoint.length > 0 ? endpoint : null;
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
      const endpoint = adapter.authorizationServerUrl
        ? await discoverIntrospectionEndpoint(adapter.authorizationServerUrl)
        : null;
      const response = endpoint
        ? await introspect(endpoint, grant.accessToken, adapter.introspectionCredentials)
        : await adapter.coLocatedIntrospect?.(grant.accessToken);
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
  // The introspection response carries the resolved enforcement constraints, and
  // Section 9 item 4 requires them to be fully expanded before issuance. A
  // wildcard or an empty field list reaching an RS is an authorization defect:
  // the RS enforces exactly this and is forbidden from resolving anything itself.
  // AS-3 is `applicability: "always"` (every grant, co-located or separated,
  // must conform to the Section 7 grant schema); only this case's MECHANISM —
  // reading the resolved grant back over RFC 7662 introspection — is
  // separated-deployment-specific. A co-located AS without an introspection
  // endpoint is missing evidence (`skip`), not exempt from the requirement, so
  // this case must not gate on `separatedDeployment` via `appliesWhen`.
  {
    caseId: "AS-3/resolved-grant-is-fully-expanded",
    requirementId: "AS-3",
    assertion:
      "The authorization_details in introspection carry concrete stream names and a non-empty resolved field list, with no wildcards.",
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
      const endpoint = adapter.authorizationServerUrl
        ? await discoverIntrospectionEndpoint(adapter.authorizationServerUrl)
        : null;
      if (!endpoint) {
        return skip(
          "AS-3 applies to this target regardless of topology, but it publishes no RFC 8414 introspection_endpoint, so this suite has no mechanism to observe the resolved grant here. Missing evidence, not an inapplicable requirement."
        );
      }
      const response = await introspect(endpoint, grant.accessToken, adapter.introspectionCredentials);
      if (response.status !== 200) {
        return fail(`Expected 200 from the introspection endpoint, got ${response.status}.`, [response.evidence]);
      }
      const details = (response.json as IntrospectionBody | undefined)?.authorization_details;
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
      const grantStreams = detail.streams ?? [];
      if (grantStreams.length === 0) {
        return fail("The resolved authorization detail names no streams.", [response.evidence]);
      }
      for (const s of grantStreams) {
        if (typeof s.name !== "string" || s.name.includes("*")) {
          return fail(
            `Stream name ${JSON.stringify(s.name)} is absent or still a wildcard. Section 9 item 4 requires wildcards to be expanded into explicit stream names before the grant is issued, because the RS may not resolve them.`,
            [response.evidence]
          );
        }
        if (!Array.isArray(s.fields) || s.fields.length === 0) {
          return fail(
            `Stream "${s.name}" carries no resolved fields allowlist. The RS enforces the fields list and cannot reconstruct it, so an empty list is an authorization defect rather than an unrestricted grant.`,
            [response.evidence]
          );
        }
        if (s.fields.includes("*")) {
          return fail(
            `Stream "${s.name}" carries a wildcard in its fields allowlist. Section 9 item 4 requires fields to be expanded before issuance.`,
            [response.evidence]
          );
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
      // later active:false proves nothing about revocation.
      const endpoint = adapter.authorizationServerUrl
        ? await discoverIntrospectionEndpoint(adapter.authorizationServerUrl)
        : null;
      if (!endpoint) {
        return skip(
          "AS-8 applies to this target regardless of topology, but it publishes no RFC 8414 introspection_endpoint, so this suite has no mechanism to observe revocation reflection here. Missing evidence, not an inapplicable requirement."
        );
      }
      const before = await introspect(endpoint, grant.accessToken, adapter.introspectionCredentials);
      if (before.status !== 200 || (before.json as IntrospectionBody | undefined)?.active !== true) {
        return skip("Introspection did not report the fresh token as active, so revocation cannot be isolated.");
      }

      await adapter.revokeGrant(grant.grantId);

      const after = await introspect(endpoint, grant.accessToken, adapter.introspectionCredentials);
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
  // Section 9 AS item 19: each authorization code is consumed atomically on its
  // first successful redemption, and every later redemption is rejected. A
  // replayable code is a credential an attacker who observes one redirect can
  // reuse to mint their own token.
  {
    caseId: "AS-19/authorization-approval-is-not-replayable",
    requirementId: "AS-19",
    assertion: "A second approval of the same staged request does not mint a second grant.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      if (!adapter.stageApproval) {
        return skip(
          "The adapter cannot stage an authorization request short of approval, so replay is not observable."
        );
      }
      const staged = await adapter.stageApproval({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
      });
      if (!staged) {
        return skip("The target could not stage an authorization request.");
      }

      const first = await staged.approve(staged.reviewRevision);
      if (!first) {
        return skip("The first approval did not succeed, so replay cannot be isolated.");
      }
      const second = await staged.approve(staged.reviewRevision);
      if (second && second.grantId !== first.grantId) {
        return fail(
          `Replaying the same approval minted a second, distinct grant (${first.grantId} then ${second.grantId}). Section 9 AS item 19 requires the authorization to be consumed atomically on first redemption and every later attempt rejected, so an observed redirect cannot be replayed into another token.`
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
];
