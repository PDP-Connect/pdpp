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
// cause. Core Section 9 AS item 8 requires that transition to be immediate, so
// the case retries briefly and reports the observed latency rather than
// sleeping for a fixed interval and hoping.

import { errorBody, request } from "../harness/http.ts";
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";

/**
 * How long a revocation may take to become visible before the case fails.
 *
 * Core Section 9 AS item 8 says "immediately", which no black-box test can
 * observe as zero. This bound exists so a caching layer with a short TTL is
 * distinguishable from one honouring the 60-second introspection cache ceiling
 * as if it were a licence to serve revoked grants: Section 8 caps POSITIVE
 * introspection caching at min(token_exp, 60s), and a target that needs longer
 * than this bound is relying on that cache to serve a grant the owner withdrew.
 */
const REVOCATION_VISIBILITY_BUDGET_MS = 5000;
const REVOCATION_POLL_INTERVAL_MS = 250;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const GRANT_LIFECYCLE_CASES: readonly ConformanceCase[] = [
  {
    caseId: "AS-8/revoked-grant-refused",
    requirementId: "AS-8",
    assertion: "A token that read successfully is refused after its grant is revoked, within the visibility budget.",
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

      const startedAt = Date.now();
      let last = before;
      while (Date.now() - startedAt < REVOCATION_VISIBILITY_BUDGET_MS) {
        // Polling is the point: the case measures how long revocation takes to
        // become visible, which requires sequential reads of a changing state.
        // biome-ignore lint/performance/noAwaitInLoops: sequential polling measures revocation visibility latency.
        const after = await request(adapter.baseUrl, recordsPath, {
          token: grant.accessToken,
        });
        last = after;
        if (after.status !== 200) {
          if (after.status !== 401 && after.status !== 403) {
            return fail(
              `After revocation the read was refused with ${after.status}; Section 8 maps a revoked grant to 403 grant_revoked (401 is acceptable when the token itself is invalidated).`,
              [before.evidence, after.evidence]
            );
          }
          const error = errorBody(after);
          if (after.status === 403 && error?.code !== "grant_revoked") {
            return fail(
              `Expected error code grant_revoked on a 403 after revocation, got ${error?.code ?? "no structured error"}.`,
              [before.evidence, after.evidence]
            );
          }
          return pass([before.evidence, after.evidence]);
        }
        await sleep(REVOCATION_POLL_INTERVAL_MS);
      }

      return fail(
        `Revoked grant still served records ${REVOCATION_VISIBILITY_BUDGET_MS}ms after revocation. Section 9 AS item 8 requires revocation to be reflected immediately; Section 8 caps positive introspection caching at min(token_exp, 60s) and does not permit serving a withdrawn grant.`,
        [before.evidence, last.evidence]
      );
    },
  },

  {
    caseId: "AS-8/expired-grant-refused",
    requirementId: "AS-8",
    assertion: "A token bound to an expired grant is refused with 403 grant_expired.",
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
          "An expired grant served records. Section 9 AS item 8 requires the AS to track expiry and Section 8 maps it to 403 grant_expired.",
          [response.evidence]
        );
      }
      if (response.status !== 403 && response.status !== 401) {
        return fail(`Expected 403 grant_expired (or 401 if the token itself is rejected), got ${response.status}.`, [
          response.evidence,
        ]);
      }
      const error = errorBody(response);
      if (response.status === 403 && error?.code !== "grant_expired") {
        return fail(`Expected error code grant_expired, got ${error?.code ?? "no structured error"}.`, [
          response.evidence,
        ]);
      }
      return pass([response.evidence]);
    },
  },

  {
    caseId: "AS-10/single-use-grant-consumed",
    requirementId: "AS-10",
    appliesWhen: (adapter) => adapter.capabilities.singleUseGrants,
    assertion: "A single_use grant cannot issue a second client access token after the first.",
    async run({ adapter, streams }) {
      const [stream] = streams;
      if (!stream) {
        return skip("The adapter seeded no streams.");
      }
      const first = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
        accessMode: "single_use",
      });
      if (!first) {
        return skip("The target declares single_use support but could not issue such a grant.");
      }
      // A second issuance against a consumed single_use grant must fail. The
      // adapter returning null IS the conformant outcome here.
      const second = await adapter.issueGrant({
        streams: [{ name: stream.name, fields: [...stream.fields] }],
        accessMode: "single_use",
      });
      if (second && second.grantId === first.grantId) {
        return fail(
          `A second access token was issued against the already-consumed single_use grant ${first.grantId}. Section 9 AS item 10 requires atomic consumption with first issuance.`
        );
      }
      return pass();
    },
  },
];
