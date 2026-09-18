// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The final approval artifact, and where client claims may and may not go.
//
// Three clauses, all about the moment between review and issuance:
//
//   7.2-2  the final approval artifact MUST carry the exact resolved
//          instance_ids, stream names, fields, resources, temporal field,
//          since, until, purpose, retention, client identity and grant expiry.
//   6.3-2  if client_claims are rendered on that surface, they MUST be
//          normalized and bound EXACTLY, WITH client attribution, into the
//          artifact and review revision, and retained evidence must preserve
//          that binding.
//   7.2-4  client_claims MUST remain outside the resolved grant and RS
//          enforcement.
//
// These are two halves of one idea and it is worth stating plainly. The
// artifact is the thing the owner actually approved, so it must be complete:
// an artifact that omits retention or grant expiry records a consent the owner
// was never shown the terms of. Client claims must appear there, because they
// are material context the owner weighed — but attributed, because they are
// unverifiable promises by the requesting client rather than protocol-enforced
// terms. And they must NOT appear in the resolved grant, because anything in
// the grant is something a resource server may enforce or a downstream
// component may read as authority.
//
// A finished grant cannot show any of this: by then the artifact either carried
// the right facts or it did not, and both look identical from outside. That is
// why every case here needs `stageApproval` plus `approvalArtifact`, and
// reports `skip` naming the missing hook when a target has neither.

import type { StagedApproval, TargetAdapter } from "../harness/adapter.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";
import type { Evidence } from "../report/result.ts";

const NO_STAGING_HOOK =
  "The adapter cannot stage an authorization request short of approval, so the final approval artifact is not observable. This needs a harness hook, not a different assertion.";

const NO_ARTIFACT_HOOK =
  "The target publishes no separable final approval artifact, so what the approval binds to cannot be inspected. The suite will not reconstruct one from its own request: a synthesized artifact would echo the request and the case would measure itself.";

/** Claims the cases submit. Distinctive so a paraphrase is detectable. */
const COMMITMENTS = [
  "Data used only for this study and deleted at its conclusion.",
  "No third-party sharing of any record retrieved under this grant.",
] as const;

function artifactEvidence(label: string, artifact: unknown): Evidence {
  return {
    request: { method: "POST", url: label, headers: {} },
    response: { status: 200, headers: {}, body: JSON.stringify(artifact) },
  };
}

/**
 * Stage a request and read back its artifact, or the reason this target cannot
 * produce one.
 */
async function stagedArtifact(
  adapter: TargetAdapter,
  request: Parameters<NonNullable<TargetAdapter["stageApproval"]>>[0]
): Promise<{ readonly staged: StagedApproval; readonly artifact: unknown } | { readonly reason: string }> {
  if (!adapter.stageApproval) {
    return { reason: NO_STAGING_HOOK };
  }
  const staged = await adapter.stageApproval(request);
  if (!staged) {
    return { reason: "The target refused to stage this authorization request, so there is no artifact to inspect." };
  }
  if (!staged.approvalArtifact) {
    return { reason: NO_ARTIFACT_HOOK };
  }
  const artifact = await staged.approvalArtifact();
  if (artifact === null || artifact === undefined) {
    return { reason: NO_ARTIFACT_HOOK };
  }
  return { artifact, staged };
}

/** Every value in the object tree, for a containment search over the grant. */
function* deepValues(value: unknown): Generator<unknown> {
  yield value;
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* deepValues(item);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      yield* deepValues(item);
    }
  }
}

/** Whether `text` appears anywhere in the structure, at any depth. */
function containsText(structure: unknown, text: string): boolean {
  for (const value of deepValues(structure)) {
    if (typeof value === "string" && value.includes(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Find a key anywhere in the artifact, at any depth, and return its value.
 *
 * Core Section 7.2 says WHICH facts the final approval artifact must carry. It
 * fixes no JSON layout for them, and real servers nest: the Personal Server
 * groups the selection under `data` and the purpose under `policy`. An oracle
 * that assumed a flat object would report "omits streams" about an artifact
 * whose `data.streams` is correct and complete — a false finding, and exactly
 * the kind this suite exists not to produce. So presence is searched for
 * structurally, and only genuine absence is reported.
 */
function findKey(structure: unknown, key: string): { readonly value: unknown } | null {
  if (Array.isArray(structure)) {
    for (const item of structure) {
      const found = findKey(item, key);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (typeof structure === "object" && structure !== null) {
    const record = structure as Record<string, unknown>;
    if (Object.hasOwn(record, key)) {
      return { value: record[key] };
    }
    for (const item of Object.values(record)) {
      const found = findKey(item, key);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/** Whether the artifact states this fact anywhere, under any of these names. */
function statesFact(artifact: unknown, names: readonly string[]): boolean {
  return names.some((name) => {
    const found = findKey(artifact, name);
    return found !== null && found.value !== null && found.value !== undefined;
  });
}

/**
 * Which Section 7.2 facts the artifact does not state.
 *
 * Checked fact by fact rather than as "an artifact exists", because the
 * realistic defect is an artifact that names the streams and fields — the facts
 * an implementer thinks of first — and drops the lifecycle ones.
 *
 * Each fact carries the alternative key names a conforming server may use, so
 * the case tests the OBLIGATION (the owner is told this) rather than one
 * server's vocabulary. Temporal facts are exempted when the staged request
 * carried no time constraint: Core requires the artifact to state the resolved
 * terms, and "there is no temporal constraint" is fully stated by the absence
 * of a time range from a request that asked for none.
 */
function missingArtifactFacts(artifact: unknown, expectTemporal: boolean): readonly string[] {
  const required: readonly (readonly [string, readonly string[]])[] = [
    ["purpose", ["purpose", "purpose_code"]],
    ["retention", ["retention", "retention_policy"]],
    ["grant expiry", ["grant_expiry", "expires_at", "grant_expires_at"]],
    ["client identity", ["client", "requester", "client_id"]],
    ["streams", ["streams"]],
    ["fields", ["fields"]],
    ["instance ids", ["instance_ids"]],
  ];
  const missing = required.filter(([, names]) => !statesFact(artifact, names)).map(([label]) => label);
  if (expectTemporal && !statesFact(artifact, ["time_range", "temporal_field", "since"])) {
    missing.push("temporal field / since / until");
  }
  return missing;
}

export const CONSENT_ARTIFACT_CASES: readonly ConformanceCase[] = [
  // ----------------------------------------------------------------- 7.2-2 ---
  {
    caseId: "AS-15/final-approval-artifact-carries-resolved-terms",
    requirementId: "AS-15",
    assertion:
      "The final approval artifact carries the resolved instance ids, streams, fields, resources, temporal field, since/until, purpose, retention, client identity and grant expiry.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream, so there is no selection to review.");
      }
      const staged = await stagedArtifact(adapter, {
        streams: [{ name: seeded.name, fields: [...seeded.fields] }],
        // Retention is REQUESTED, never invented by the AS, so the request has
        // to carry one for the artifact to be able to state it. Without this
        // the case reports "the artifact omits retention" against a server that
        // was never asked for any — a loud false finding, and precisely the
        // failure batch 5 caught once already on this same clause.
        retention: { maxDuration: "P30D", onExpiry: "delete" },
        ...(seeded.consentTimeField
          ? { timeConstraint: { field: seeded.consentTimeField, from: "2026-01-01T00:00:00Z" } }
          : {}),
      });
      if ("reason" in staged) {
        return skip(staged.reason);
      }
      const evidence = [artifactEvidence("final approval artifact", staged.artifact)];

      // Section 7.2 names these facts individually, so they are checked
      // individually: an artifact carrying the streams but not the retention is
      // the realistic defect, and a case asserting only "an artifact exists"
      // would pass against it.
      const missing = missingArtifactFacts(staged.artifact, seeded.consentTimeField !== undefined);
      if (missing.length > 0) {
        return fail(
          `The final approval artifact does not state ${missing.join(", ")}. Core Section 7.2: the artifact MUST include the exact resolved instance_ids, stream names, fields, resources, temporal field, since, until, purpose, retention, client identity and grant expiry. What is missing is what the owner was not shown before approving — an artifact without retention or grant expiry records a consent whose duration nobody stated. (Presence is searched at any depth and under the usual alternative names, so a nested layout is not itself a finding.)`,
          evidence
        );
      }

      // Present is not the same as correct: the artifact must describe THIS
      // authorization. An artifact naming a different stream would satisfy
      // every presence check above while describing another request.
      if (!containsText(staged.artifact, seeded.name)) {
        return fail(
          `The artifact never names stream "${seeded.name}", which the staged request selected, so it does not describe the authorization under review.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 6.3-2 ---
  {
    caseId: "AS-15/rendered-client-claims-bound-with-attribution",
    requirementId: "AS-15",
    assertion:
      "Client claims rendered on the review surface are bound into the final approval artifact exactly as submitted and attributed to the client.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream, so there is no selection to attach claims to.");
      }
      const staged = await stagedArtifact(adapter, {
        streams: [{ name: seeded.name, fields: [...seeded.fields] }],
        clientClaims: { commitments: [...COMMITMENTS] },
      });
      if ("reason" in staged) {
        return skip(staged.reason);
      }
      const evidence = [artifactEvidence("final approval artifact with client_claims", staged.artifact)];
      const artifact = staged.artifact as Record<string, unknown>;
      const bound = artifact.client_claims as { attributed_to?: unknown; commitments?: unknown } | undefined;

      if (!bound) {
        // Core gates this clause on the claims being RENDERED. A target that
        // renders none is outside its applicability rather than in violation,
        // and saying so is more honest than failing it.
        return skip(
          "The staged artifact carries no client_claims, so this deployment does not render them on the final review surface and clause 6.3-2's condition is not met. A target that renders claims binds them here."
        );
      }

      const commitments = Array.isArray(bound.commitments) ? bound.commitments.map(String) : [];
      const missing = COMMITMENTS.filter((c) => !commitments.includes(c));
      if (missing.length > 0) {
        return fail(
          `The artifact binds client claims that are not the ones submitted. Missing verbatim: ${missing.map((c) => JSON.stringify(c)).join(", ")}; bound instead: ${JSON.stringify(commitments)}. Core Section 6: rendered claims MUST be normalized and bound EXACTLY. Retained consent evidence that says something the client did not say cannot support the consent it records.`,
          evidence
        );
      }
      if (bound.attributed_to === undefined || bound.attributed_to === null || bound.attributed_to === "") {
        return fail(
          `The artifact binds the client claims but carries no client attribution for them. Core Section 6 requires the claims to be bound "with client attribution", and the trust boundary is the reason: claims are self-asserted and unverifiable, so an unattributed commitment reads on the review surface as a term the protocol enforces rather than as a promise by the requesting client.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },

  // ----------------------------------------------------------------- 7.2-4 ---
  {
    caseId: "AS-3/client-claims-stay-outside-the-resolved-grant",
    requirementId: "AS-3",
    assertion: "Client claims submitted with a selection request do not appear in the resolved grant.",
    async run({ adapter, streams }) {
      const [seeded] = streams;
      if (!seeded) {
        return skip("No seeded stream, so there is no grant to inspect.");
      }
      const issued = await adapter.issueGrant({
        streams: [{ name: seeded.name, fields: [...seeded.fields] }],
        clientClaims: { commitments: [...COMMITMENTS] },
      });
      if (!issued) {
        return skip("The target issued no grant for a request carrying client claims, so there is nothing to inspect.");
      }
      if (issued.rawGrant === undefined) {
        return skip(
          "The target's approval surface returned no grant artifact, so whether client claims reached the resolved grant is unobserved. The suite will not treat an unreadable grant as evidence of their absence."
        );
      }
      const evidence = [artifactEvidence("resolved grant for a claims-bearing request", issued.rawGrant)];

      // Searched at any depth and by CONTENT rather than by key name: a server
      // that carried the claims under a different key, or nested inside a
      // stream row, has leaked them just as surely as one using the obvious
      // name. The commitments are distinctive sentences, so a match is the
      // client's text and not a coincidence.
      const leaked = COMMITMENTS.filter((c) => containsText(issued.rawGrant, c));
      if (leaked.length > 0) {
        return fail(
          `The resolved grant carries the client's claims: ${leaked.map((c) => JSON.stringify(c)).join(", ")}. Core Section 7.2: client_claims MUST remain outside the resolved grant and RS enforcement. They are unverifiable, self-asserted statements; inside the grant they become something a resource server may enforce or a downstream component may read as authorization, which is exactly the confusion the trust boundary exists to prevent.`,
          evidence
        );
      }
      return pass(evidence);
    },
  },
];
