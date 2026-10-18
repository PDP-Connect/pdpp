// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Grant lifecycle negative oracles: revocation and expiry.
//
// These carry more weight than their case count suggests. GOVERNANCE.md Section
// 5 describes Verified Operator as the status for an implementation that
// "enforces the terms of each grant as recorded, refuses anything outside them,
// and revokes access when the user asks". The third clause is exactly what
// these cases test, and it is the one an implementation is most likely to get
// subtly wrong: revocation that updates a database row but not the token cache
// looks correct in every functional test and fails here.
//
// The revocation case is written as a before/after pair on the SAME token. A
// post-revocation 403 alone proves nothing — the token might have been invalid
// from the start, or the stream unreadable for an unrelated reason. Only the
// transition from a working read to a refused one isolates revocation as the
// cause. The resource server may lag revocation by up to the 60-second
// introspection-cache ceiling (the AS itself must not; a sibling case checks
// that), so the case polls until the ceiling rather than sleeping for a fixed
// interval and hoping.

import { errorBody, type PdppResponse, request } from "../harness/http.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";

/**
 * How long resource-server reads may keep serving a revoked grant before the
 * case fails.
 *
 * Core Section 9 AS item 8 requires the AS to reflect revocation immediately in
 * INTROSPECTION; that half is asserted by AS-8/revoked-token-introspects-inactive.
 * This case observes the resource server, which Section 8 ("Revocation") lets
 * lag: propagation is bounded by the introspection cache TTL, "a client will
 * receive a 403 grant_revoked response no later than 60 seconds after
 * revocation". So a refusal at any point inside the ceiling is conformant and
 * only a read still served after it is a failure. The two seconds of slack
 * cover the transport time of the last poll, not extra propagation time.
 *
 * Targets that revoke immediately return on the first poll, so the ceiling
 * costs nothing on them. The object is mutable only so the proof test can
 * shorten the wait for the deliberately violating server.
 */
export const REVOCATION_TIMING = {
  ceilingMs: 60_000 + 2000,
  pollIntervalMs: 250,
  slowPollAfterMs: 5000,
  slowPollIntervalMs: 1000,
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Polls a records read with `token` until the resource server stops serving it
 * (`refused`: the first non-200 answer, for the caller to classify) or the
 * shared propagation ceiling passes (`stillServed`). Every case that waits for
 * the RS to reflect an AS-side revocation uses this one clock, so none of them
 * demands more immediacy than Section 8's 60-second introspection-cache ceiling
 * allows.
 */
export async function pollResourceServerRefusal(
  baseUrl: string,
  recordsPath: string,
  token: string,
  seed: PdppResponse
): Promise<{ readonly refused: PdppResponse } | { readonly stillServed: PdppResponse }> {
  const startedAt = Date.now();
  let last = seed;
  while (Date.now() - startedAt < REVOCATION_TIMING.ceilingMs) {
    // Polling is the point: the case measures how long revocation takes to
    // become visible, which requires sequential reads of a changing state.
    // biome-ignore lint/performance/noAwaitInLoops: sequential polling measures revocation visibility latency.
    const after = await request(baseUrl, recordsPath, { token });
    last = after;
    if (after.status !== 200) {
      return { refused: after };
    }
    await sleep(
      Date.now() - startedAt < REVOCATION_TIMING.slowPollAfterMs
        ? REVOCATION_TIMING.pollIntervalMs
        : REVOCATION_TIMING.slowPollIntervalMs
    );
  }
  return { stillServed: last };
}

const BEARER_INVALID_TOKEN = /^Bearer\b.*\berror="?invalid_token"?/i;

/**
 * Judge a refused read of an inactive token against Section 8 "Inactive tokens":
 * every inactive access token is HTTP 401 with `WWW-Authenticate: Bearer
 * error="invalid_token"`. The structured error MAY name the cause
 * (`grant_revoked` / `grant_expired`, both 401 `authentication_error`) and
 * otherwise is `authentication_error`; any other code, or a 403, is a failure.
 * Returns a failure message, or undefined when the refusal is conformant.
 */
function inactiveTokenFault(
  response: Awaited<ReturnType<typeof request>>,
  causeCode: "grant_expired" | "grant_revoked"
): string | undefined {
  if (response.status !== 401) {
    return `An inactive token was refused with ${response.status}; Section 8 "Inactive tokens" makes every inactive access token HTTP 401 (\`${causeCode}\` is 401 \`authentication_error\`, not 403).`;
  }
  const challenge = response.headers.get("www-authenticate");
  if (!(challenge && BEARER_INVALID_TOKEN.test(challenge))) {
    return `The 401 for an inactive token must carry \`WWW-Authenticate: Bearer error="invalid_token"\`; observed ${challenge === null ? "no WWW-Authenticate header" : `"${challenge}"`}.`;
  }
  const error = errorBody(response);
  if (error?.code !== undefined && error.code !== "authentication_error" && error.code !== causeCode) {
    return `The structured error code for an inactive token must be \`authentication_error\` or, when the cause is established, \`${causeCode}\`; got ${error.code}.`;
  }
  if (error?.type !== undefined && error.type !== "authentication_error") {
    return `The structured error type for an inactive token must be \`authentication_error\`; got ${error.type}.`;
  }
  return undefined;
}

export const GRANT_LIFECYCLE_CASES: readonly ConformanceCase[] = [
  {
    caseId: "AS-8/revoked-grant-refused",
    requirementId: "AS-8",
    assertion:
      "A token that read successfully is refused by the resource server after its grant is revoked, no later than the 60-second propagation ceiling.",
    async run({ adapter, streams, path }) {
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

      const recordsPath = path(`/streams/${encodeURIComponent(stream.name)}/records`);

      // Before: establish that this exact token reads the stream. Without this
      // control a later 403 would not isolate revocation as its cause.
      const before = await request(adapter.baseUrl, recordsPath, {
        token: grant.accessToken,
      });
      if (before.status !== 200) {
        return skip(
          `The grant did not permit a read before revocation (${before.status}), so revocation cannot be isolated.`
        );
      }

      await adapter.revokeGrant(grant.grantId);

      const polled = await pollResourceServerRefusal(adapter.baseUrl, recordsPath, grant.accessToken, before);
      if ("refused" in polled) {
        const after = polled.refused;
        const fault = inactiveTokenFault(after, "grant_revoked");
        return fault ? fail(fault, [before.evidence, after.evidence]) : pass([before.evidence, after.evidence]);
      }
      const last = polled.stillServed;

      return fail(
        `Revoked grant still served records ${REVOCATION_TIMING.ceilingMs}ms after revocation. Section 8 (Revocation) bounds propagation to the resource server at 60 seconds; Section 8 caps positive introspection caching at min(token_exp, 60s).`,
        [before.evidence, last.evidence]
      );
    },
  },

  {
    caseId: "AS-8/expired-grant-refused",
    requirementId: "AS-8",
    assertion:
      "A token bound to an expired grant is refused with 401 and a Bearer invalid_token challenge, not served.",
    async run({ adapter, streams, path }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      if (!adapter.expiredGrantToken) {
        return skip(
          "The adapter cannot produce a token bound to an expired grant, so expiry enforcement is not demonstrable."
        );
      }
      const token = await adapter.expiredGrantToken();
      if (!token) {
        return skip("The adapter returned no expired-grant token.");
      }
      const response = await request(adapter.baseUrl, path(`/streams/${encodeURIComponent(stream.name)}/records`), {
        token,
      });
      if (response.status === 200) {
        return fail(
          "An expired grant served records. Section 9 AS item 8 requires the AS to track expiry and Section 8 \"Inactive tokens\" makes it a 401.",
          [response.evidence]
        );
      }
      const fault = inactiveTokenFault(response, "grant_expired");
      if (fault) {
        return fail(fault, [response.evidence]);
      }
      return pass([response.evidence]);
    },
  },

  {
    caseId: "AS-10/single-use-grant-consumed",
    requirementId: "AS-10",
    appliesWhen: (adapter) => adapter.capabilities.singleUseGrants,
    assertion: "A second client access token attempted against the SAME already-consumed single_use grant is refused.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      if (!adapter.reissueAgainstConsumedGrant) {
        // Issuing a second, DIFFERENT grant does not test reuse of the first:
        // a target that always mints a fresh grant would pass that check
        // vacuously. Only an attempt against the SAME grant id isolates
        // atomic consumption, and this harness has no hook to drive that
        // attempt yet. This is a harness-coverage gap, not a target defect —
        // the target's declared singleUseGrants capability is not in
        // question here.
        return skip(
          "The adapter declares singleUseGrants but implements no reissueAgainstConsumedGrant hook, so the suite cannot attempt a second token issuance against the SAME consumed grant. A second, different grant would not prove reuse of the first is refused."
        );
      }
      const first = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
        accessMode: "single_use",
      });
      if (!first) {
        return skip("The target declares single_use support but could not issue such a grant.");
      }
      // A reissuance attempt against the SAME consumed grant id must be
      // refused. The hook returning null IS the conformant outcome here.
      const replay = await adapter.reissueAgainstConsumedGrant(first.grantId);
      if (replay) {
        return fail(
          `A second access token was issued against the already-consumed single_use grant ${first.grantId}. Section 9 AS item 10 requires atomic consumption with first issuance.`
        );
      }
      return pass();
    },
  },
];
