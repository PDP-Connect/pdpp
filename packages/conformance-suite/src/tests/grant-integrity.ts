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

import { request } from "../harness/http.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";

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
      if (!second) {
        return fail(
          "A refresh token issued for a continuous grant was refused on its first use, so the family never rotated."
        );
      }
      if (second.refreshToken === first.refreshToken) {
        return fail(
          "Refreshing returned the same refresh token rather than a successor. Core requires each token to rotate after successful use: without rotation there is no superseded token to detect, so a stolen refresh token is valid for the life of the grant."
        );
      }

      // Leg 2: replay the superseded token. This models exactly the attacker
      // scenario rotation exists to catch.
      const replayed = await first.refresh(first.refreshToken);
      if (replayed) {
        return fail(
          "Replaying a superseded refresh token issued a further token rather than being refused. Core requires reuse of any superseded token to return invalid_grant and revoke the family: accepting it means a leaked token keeps working indefinitely, and the rotation that should have exposed the leak conceals it instead."
        );
      }

      // Leg 3: the part a refusal alone does not prove. Revoking the family MUST
      // also kill access tokens linked to it — including the successor the
      // legitimate client is holding right now. A server that merely declines to
      // mint new tokens leaves the stolen session alive.
      const afterReuse = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(seeded.name)}/records`), {
        token: second.accessToken,
      });
      if (afterReuse.status === 200) {
        return fail(
          "After refresh-token reuse was detected, an access token from the same family still served records. Core requires every family-linked access token to be revoked and introspection to report them inactive: refusing only new refreshes leaves the compromised session live until the token happens to expire.",
          [afterReuse.evidence]
        );
      }
      return pass([afterReuse.evidence]);
    },
  },
];
