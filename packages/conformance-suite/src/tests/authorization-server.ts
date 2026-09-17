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
import { type ConformanceCase, fail, pass, skip } from "../harness/runner.ts";

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
  {
    caseId: "AS-9/introspection-carries-pdpp-extensions",
    requirementId: "AS-9",
    appliesWhen: (adapter) => adapter.capabilities.separatedDeployment,
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
      if (!endpoint) {
        return skip(
          "The target declares a separated deployment but publishes no introspection_endpoint in its RFC 8414 authorization server metadata."
        );
      }
      const response = await introspect(endpoint, grant.accessToken, adapter.introspectionCredentials);
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
  {
    caseId: "AS-3/resolved-grant-is-fully-expanded",
    requirementId: "AS-3",
    appliesWhen: (adapter) => adapter.capabilities.separatedDeployment,
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
          "The target declares a separated deployment but publishes no introspection_endpoint in its RFC 8414 authorization server metadata."
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
  // RFC 7662 Section 2.2 requires an inactive token to return active:false and
  // nothing that describes it. An AS that keeps echoing the subject, client or
  // grant of a revoked token leaks who held it and what it covered, to any
  // caller able to present the string.
  {
    caseId: "AS-8/revoked-token-introspects-inactive-without-detail",
    requirementId: "AS-8",
    appliesWhen: (adapter) => adapter.capabilities.separatedDeployment,
    assertion:
      "After revocation, introspection reports active false and discloses no subject, client, grant or authorization detail.",
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
          "The target declares a separated deployment but publishes no introspection_endpoint in its RFC 8414 authorization server metadata."
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
      const leaked = (["subject_id", "client_id", "grant_id", "authorization_details"] as const).filter(
        (key) => body[key] !== undefined
      );
      if (leaked.length > 0) {
        return fail(
          `Introspection of a revoked token still disclosed ${leaked.join(", ")}. RFC 7662 Section 2.2 requires an inactive response to carry no information about the token.`,
          [before.evidence, after.evidence]
        );
      }
      return pass([before.evidence, after.evidence]);
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
];
