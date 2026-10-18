// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// What the authorization server FREEZES into a grant, and what it does with the
// credentials that grant issues.
//
// The unifying idea: a grant is a frozen artifact, not a live query. Everything
// convenient about a selection request — an omitted field list, a wildcard, an
// implied instance — has to be resolved before issuance, because after issuance
// there is no one left to ask. A grant that still contains "whatever the
// declaration says" silently widens when the declaration changes, and the owner
// approved the narrower thing.

import type { RefreshableGrant, RefreshRefusal } from "../harness/adapter.ts";
import { type PdppResponse, request } from "../harness/http.ts";
import { arrange, type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";
import { introspectByAnyRoute } from "./authorization-server.ts";
import { pollResourceServerRefusal, REVOCATION_TIMING } from "./grant-lifecycle.ts";

const isGrant = (value: RefreshableGrant | RefreshRefusal): value is RefreshableGrant => "refreshToken" in value;

/**
 * Evidence for a resolved grant the adapter read rather than an HTTP exchange
 * the harness captured. Shaped the same so a reader does not have to care which.
 */
function resolvedGrantEvidence(
  streams: readonly { readonly name: string; readonly fields: readonly string[] }[]
): Evidence {
  return {
    request: { method: "POST", url: "stageApproval: stream requested with no field list", headers: {} },
    response: { status: 200, headers: {}, body: JSON.stringify({ streams }) },
  };
}

/**
 * What an introspection answer shows about the family-linked token, for the AS
 * half of revocation (Core Section 9 AS item 8). Only `inactive` demonstrates it.
 */
type IntrospectionObservation =
  | { readonly kind: "inactive"; readonly evidence: Evidence }
  | { readonly kind: "violation"; readonly detail: string; readonly evidence: Evidence }
  | { readonly kind: "unobserved"; readonly reason: string };

/**
 * Classify an introspection answer. Only a 200 answers about the token, and its
 * body must carry `active` as a JSON boolean (RFC 7662 Section 2.2 makes it
 * REQUIRED), so a body without one is a violation, not a missing answer. Any other
 * status (no route, refused suite credentials, a transient error) is no answer.
 */
function observeIntrospection(response: PdppResponse | null | undefined): IntrospectionObservation {
  if (!response) {
    return { kind: "unobserved", reason: "no usable introspection route was found" };
  }
  if (response.status !== 200) {
    return { kind: "unobserved", reason: `the endpoint answered ${response.status}` };
  }
  const active = (response.json as { active?: unknown } | null | undefined)?.active;
  if (typeof active !== "boolean") {
    return {
      kind: "violation",
      detail:
        "After refresh-token reuse was detected, introspection answered 200 with a body that does not carry `active` as a JSON boolean. RFC 7662 Section 2.2 requires that member, so the AS did not answer as an introspection endpoint and family revocation is not shown.",
      evidence: response.evidence,
    };
  }
  if (active) {
    return {
      kind: "violation",
      detail:
        "After refresh-token reuse was detected, introspection still reported a family-linked access token active. Core requires introspection to report every family-linked access token inactive.",
      evidence: response.evidence,
    };
  }
  return { kind: "inactive", evidence: response.evidence };
}

export const GRANT_INTEGRITY_CASES: readonly ConformanceCase[] = [
  // ----------------------------------------------------------------- AS-4 ---
  // Section 9 AS item 4: expand request-time conveniences into explicit stream
  // names, fields, instance handles and frozen time constraints BEFORE issuing.
  //
  // The case sends a stream with no `fields` at all — the most common
  // convenience — and requires the reviewed grant to name them explicitly. A
  // server that stores the omission instead has written "all current fields" into
  // a durable grant: add a field to the declaration next week and the grant
  // silently covers it, having never been reviewed by the owner. Core Section 7
  // is explicit that these conveniences "are not continuing authority in the
  // grant".
  {
    caseId: "AS-4/omitted-fields-expanded-before-issuance",
    requirementId: "AS-4",
    assertion: "A stream requested with no field list is expanded to an explicit resolved field list before issuance.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to request.");
      }
      if (!adapter.stageApproval) {
        return skip("The adapter has no stageApproval hook, so the resolved grant cannot be read before approval.");
      }
      // An empty `fields` array is this suite's representation of "the client
      // named no fields"; the adapter omits the key entirely on the wire.
      const staged = await adapter.stageApproval({ streams: [{ name: seeded.name, fields: [] }] });
      if (!staged) {
        return skip("The target refused to stage a selection request naming no fields.");
      }

      const reviewed = await adapter.reviewedStreams?.(staged.handle);
      if (!reviewed) {
        return skip(
          "The adapter cannot read the reviewed grant for a staged request, so field expansion is not observable."
        );
      }
      const stream = reviewed.find((s) => s.name === seeded.name);
      if (!stream) {
        return fail(
          `The reviewed grant names no stream "${seeded.name}", so the requested selection did not survive into the grant at all.`
        );
      }
      if (stream.fields.length === 0) {
        return fail(
          "A stream requested with no field list was carried into the grant still with no field list. Section 9 AS item 4 requires expansion before issuance: an unresolved field list is not a frozen authorization but a live reference to the current declaration, so the grant widens whenever the declaration does — over data the owner never reviewed.",
          [resolvedGrantEvidence(reviewed)]
        );
      }
      // The resolved list must also be real: fields the declaration actually
      // has. A server could "expand" to a wildcard string and satisfy a naive
      // length check.
      const undeclared = stream.fields.filter((f) => !seeded.fields.includes(f));
      if (undeclared.length > 0) {
        return fail(
          `The expanded field list contains ${undeclared.map((f) => `"${f}"`).join(", ")}, which the seeded declaration does not declare. Expansion must resolve to the declared schema, not to a placeholder or a wildcard.`,
          [resolvedGrantEvidence(reviewed)]
        );
      }
      return pass([resolvedGrantEvidence(reviewed)]);
    },
  },

  // ----------------------------------------------------------------- AS-4 ---
  // The other half of item 4: a wildcard STREAM name, not an omitted field list.
  //
  // Oracle is `reviewedStreams`, which reads the target's own resolved review
  // body (`review.data.streams`). That matters: `IssuedGrant.streams` is built
  // by mapping the suite's own `GrantRequest`, so a wildcard asserted against it
  // would survive by construction and the case would pass or fail on adapter
  // bookkeeping rather than target behaviour. The review body is the target's
  // output, so a literal `"*"` appearing there is the target's doing.
  //
  // Requirement: either the target refuses the wildcard request outright (also
  // conformant — Section 7 permits a wildcard as a request-time convenience but
  // does not require supporting it), or it resolves it into concrete declared
  // stream names. Carrying `"*"` through to the reviewed grant is the defect:
  // the owner then reviews, and the RS later enforces, a name that means "the
  // current declaration" rather than a frozen set.
  {
    caseId: "AS-4/wildcard-stream-name-expanded-before-issuance",
    requirementId: "AS-4",
    assertion:
      'A selection request naming the wildcard stream "*" is resolved into concrete declared stream names before the grant is reviewed, or refused outright.',
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to compare an expansion against.");
      }
      if (!adapter.stageApproval) {
        return skip("The adapter has no stageApproval hook, so the resolved grant cannot be read before approval.");
      }
      const staged = await adapter.stageApproval({ streams: [{ name: "*", fields: [] }] });
      if (!staged) {
        return skip(
          'The target refused to stage a selection request naming the wildcard stream "*". Section 7 makes wildcards an optional request-time convenience, so refusing one is conformant and leaves nothing to expand.'
        );
      }

      const reviewed = await adapter.reviewedStreams?.(staged.handle);
      if (!reviewed) {
        return skip(
          "The adapter cannot read the reviewed grant for a staged request, so wildcard expansion is not observable."
        );
      }
      const literal = reviewed.filter((s) => s.name.includes("*"));
      if (literal.length > 0) {
        return fail(
          `The reviewed grant still names ${literal.map((s) => `"${s.name}"`).join(", ")}. Section 9 AS item 4 requires wildcards to be expanded into explicit stream names before issuance, and Section 7's StreamGrant table requires \`name\` to be concrete: a wildcard reaching the grant is a live reference to the current declaration, so the grant widens whenever the declaration does.`,
          [resolvedGrantEvidence(reviewed)]
        );
      }
      if (reviewed.length === 0) {
        return fail(
          "The target staged a wildcard stream request and then reviewed a grant naming no streams at all, so the wildcard resolved to nothing rather than to the declared streams.",
          [resolvedGrantEvidence(reviewed)]
        );
      }
      return pass([resolvedGrantEvidence(reviewed)]);
    },
  },

  // ---------------------------------------------------------------- AS-20 ---
  // Section 9 AS item 20 and Core "Token security": refresh tokens rotate by
  // family, and reuse of a superseded token revokes the family AND every access
  // token linked to it, returning `invalid_grant`.
  //
  // This is the one requirement in this batch where a partial implementation is
  // more dangerous than none. A server that rotates but does not detect reuse
  // gives an attacker holding a stolen refresh token indefinite access, while the
  // legitimate client's rotation makes everything look healthy. So the case
  // checks three things in order — rotation happens, reuse is refused, and the
  // family's access token actually dies — and the third is the one that
  // distinguishes real revocation from a refusal that only blocks new tokens.
  {
    caseId: "AS-20/refresh-reuse-revokes-the-family",
    requirementId: "AS-20",
    appliesWhen: (adapter) => adapter.capabilities.refreshTokens,
    assertion:
      "A refresh token rotates on use, and replaying the superseded token returns invalid_grant and revokes the family's access tokens.",
    async run({ adapter, streams, path }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a continuous grant from.");
      }
      if (!adapter.issueRefreshableGrant) {
        return skip(
          "The adapter has no issueRefreshableGrant hook, so refresh-token family behaviour cannot be observed."
        );
      }
      const first = await adapter.issueRefreshableGrant({
        streams: [{ name: seeded.name, fields: [...seeded.fields] }],
        accessMode: "continuous",
      });
      if (!first) {
        return skip("The target issued no refresh token for a continuous grant.");
      }

      // Leg 1: rotation. The successor must be a DIFFERENT token; a server that
      // returns the same string has not rotated and reuse detection is
      // impossible by construction.
      const second = await first.refresh(first.refreshToken);
      if (!(second && isGrant(second))) {
        return fail(
          "A refresh token issued for a continuous grant was refused on its first use, so the family never rotated."
        );
      }
      if (second.refreshToken === first.refreshToken) {
        return fail(
          "Refreshing returned the same refresh token rather than a successor. Core requires each token to rotate after successful use: without rotation there is no superseded token to detect, so a stolen refresh token is valid for the life of the grant."
        );
      }

      // Control: the successor must read BEFORE the replay. Without it a later
      // refusal could be an unrelated failure of the token, the stream or the
      // server rather than revocation of the family.
      const recordsPath = path(`/streams/${encodeURIComponent(seeded.name)}/records`);
      const beforeReplay = await request(adapter.baseUrl, recordsPath, { token: second.accessToken });
      if (beforeReplay.status !== 200) {
        return skip(
          `The successor access token could not read the stream before the replay (${beforeReplay.status}), so a refusal afterwards would not isolate family revocation.`
        );
      }

      // Leg 2: replay the superseded token. This models exactly the attacker
      // scenario rotation exists to catch.
      const replayed = await first.refresh(first.refreshToken);
      if (replayed && isGrant(replayed)) {
        return fail(
          "Replaying a superseded refresh token issued a further token rather than being refused. Core requires reuse of any superseded token to return invalid_grant and revoke the family: accepting it means a leaked token keeps working indefinitely, and the rotation that should have exposed the leak conceals it instead."
        );
      }
      if (!replayed) {
        return skip(
          "The replay was refused but the adapter reported no status or error code, so invalid_grant cannot be confirmed. Return a RefreshRefusal from the refresh hook."
        );
      }
      // 404/405 mean the token route is not here at all; that is an unavailable
      // route, not the semantic refusal the clause requires.
      if (replayed.status >= 500 || replayed.status < 400 || replayed.status === 404 || replayed.status === 405) {
        return skip(
          `The replay answered ${replayed.status}, which is not a refusal of the superseded token, so neither invalid_grant nor family revocation is demonstrated.`
        );
      }
      if (replayed.errorCode !== "invalid_grant") {
        return fail(
          `Replaying a superseded refresh token returned ${replayed.status} "${replayed.errorCode ?? "no error code"}". Core requires reuse of any superseded token to return invalid_grant.`
        );
      }

      // Leg 3: the part a refusal alone does not prove. Revoking the family MUST
      // also kill access tokens linked to it — including the successor the
      // legitimate client is holding right now. A server that merely declines to
      // mint new tokens leaves the stolen session alive.
      // The AS half is immediate (Core Section 9 AS item 8; introspection has no
      // propagation allowance). Check it first, on its own clock, so an RS that
      // legitimately serves a cached positive context for up to 60 seconds is
      // not mistaken for an AS that failed to revoke.
      //
      // Only an observed `active: false` demonstrates this half. A violating answer
      // fails here; an unobserved one can only skip, after the RS poll below.
      const introspection = observeIntrospection(await introspectByAnyRoute(adapter, second.accessToken));
      if (introspection.kind === "violation") {
        return fail(introspection.detail, [introspection.evidence]);
      }

      // The RS half may lag by the introspection-cache ceiling (Section 8,
      // Revocation); poll on the shared clock rather than demanding a refusal on
      // the first read.
      const polled = await pollResourceServerRefusal(adapter.baseUrl, recordsPath, second.accessToken, beforeReplay);
      if ("stillServed" in polled) {
        return fail(
          `After refresh-token reuse was detected, an access token from the same family still served records ${REVOCATION_TIMING.ceilingMs}ms later. Core requires every family-linked access token to be revoked and introspection to report them inactive: refusing only new refreshes leaves the compromised session live until the token happens to expire.`,
          [polled.stillServed.evidence]
        );
      }
      const afterReuse = polled.refused;
      if (afterReuse.status !== 401 && afterReuse.status !== 403) {
        return skip(
          `After the replay the successor token read answered ${afterReuse.status}, neither a success nor a token refusal, so family revocation is not demonstrated.`
        );
      }
      // A refusal alone does not show that the AS revoked the family, so the pass
      // needs the observed `active: false` above.
      if (introspection.kind === "unobserved") {
        return skip(
          `The successor token was refused, but introspection gave no observed inactive state (${introspection.reason}). A refusal alone does not show that the AS revoked the family.`
        );
      }
      return pass([introspection.evidence, afterReuse.evidence]);
    },
  },
  // ----------------------------------------------------------------- 10.7-3 ---
  {
    caseId: "AS-25/refresh-token-revocation-ends-the-family-grants",
    requirementId: "AS-25",
    appliesWhen: (adapter) => adapter.capabilities.refreshTokens,
    assertion:
      "Revoking a refresh token at the revocation endpoint ends the grant its family covers, so an access token of that family is refused afterwards.",
    async run({ adapter, streams, path }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a continuous grant from.");
      }
      if (!(adapter.issueRefreshableGrant && adapter.revokeToken)) {
        return skip("The adapter needs issueRefreshableGrant and revokeToken to revoke a refresh token as a client.");
      }
      const first = await adapter.issueRefreshableGrant({
        streams: [{ name: seeded.name, fields: [...seeded.fields] }],
        accessMode: "continuous",
      });
      if (!first) {
        return skip("The target issued no refresh token for a continuous grant.");
      }
      const recordsPath = path(`/streams/${encodeURIComponent(seeded.name)}/records`);
      const before = await request(adapter.baseUrl, recordsPath, { token: first.accessToken });
      if (before.status !== 200) {
        return skip(`The family's access token did not read before revocation (${before.status}).`);
      }
      const revoked = await adapter.revokeToken(first.refreshToken, "refresh_token");
      if (!revoked || revoked.status >= 300) {
        return skip(`The revocation endpoint did not accept the refresh token (${revoked?.status ?? "no answer"}).`);
      }
      const after = await request(adapter.baseUrl, recordsPath, { token: first.accessToken });
      if (after.status === 200) {
        return fail(
          "After the refresh token was revoked at the revocation endpoint, an access token issued under the same grant still served records. Core Section 10: when a client revokes a refresh token, the AS MUST end every grant the token's family covers and every access token issued under those grants.",
          [before.evidence, after.evidence]
        );
      }
      return pass([before.evidence, after.evidence]);
    },
  },

  // ----------------------------------------------------------------- 10.7-5 ---
  {
    caseId: "AS-25/access-token-revocation-spares-a-grant-a-family-covers",
    requirementId: "AS-25",
    appliesWhen: (adapter) => adapter.capabilities.refreshTokens,
    assertion:
      "Revoking one access token of a refresh-covered grant ends that token but leaves a sibling access token of the same family reading.",
    async run({ adapter, streams, path }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream to build a continuous grant from.");
      }
      if (!(adapter.issueRefreshableGrant && adapter.revokeToken)) {
        return skip("The adapter needs issueRefreshableGrant and revokeToken to revoke an access token as a client.");
      }
      const first = await adapter.issueRefreshableGrant({
        streams: [{ name: seeded.name, fields: [...seeded.fields] }],
        accessMode: "continuous",
      });
      const refreshed = first && (await arrange("refresh", () => first.refresh(first.refreshToken)));
      const second = refreshed && isGrant(refreshed) ? refreshed : undefined;
      if (!(first && second)) {
        return skip("The target did not yield two access tokens of one refresh-token family.");
      }
      const recordsPath = path(`/streams/${encodeURIComponent(seeded.name)}/records`);
      const revoked = await adapter.revokeToken(first.accessToken, "access_token");
      if (!revoked || revoked.status >= 300) {
        return skip(`The revocation endpoint did not accept the access token (${revoked?.status ?? "no answer"}).`);
      }
      const ended = await request(adapter.baseUrl, recordsPath, { token: first.accessToken });
      if (ended.status === 200) {
        return skip(
          "The revoked access token still read, which AS-25/client-revocation-of-an-access-token-ends-it judges."
        );
      }
      const sibling = await request(adapter.baseUrl, recordsPath, { token: second.accessToken });
      if (sibling.status !== 200) {
        return fail(
          `After one access token was revoked, a sibling access token of the same refresh-token family was refused (${sibling.status}). Core Section 10: the AS ends the token's grants only when no refresh-token family covers them; here a family covers the grant, so revoking one access token must not end it.`,
          [ended.evidence, sibling.evidence]
        );
      }
      return pass([ended.evidence, sibling.evidence]);
    },
  },
];
