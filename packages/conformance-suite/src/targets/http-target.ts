// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// An adapter for a real PDPP server reached over HTTP.
//
// This is the adapter a vendor actually uses, and the one that proves the suite
// is not shaped around its own bundled fixture. It contains no knowledge of any
// particular implementation: the Section 8 endpoint paths are the spec's, and
// everything deployment-specific — base URL, how to obtain tokens, what was
// seeded — arrives as configuration.
//
// Two provisioning strategies are supported, because the spec deliberately
// leaves credential acquisition out of scope (Core Section 8 "Authentication")
// and real deployments differ:
//
//   `preprovisioned` — the operator supplies tokens they minted out of band.
//     Works against any target, including one with no automatable grant flow,
//     which is the common case for a first integration run.
//   `endpoint` — the suite calls a grant-issuing endpoint the target exposes.
//     Needed for the cases that must issue a grant of a specific shape
//     (field-narrowed projections, revocation) rather than reuse a fixed one.
//
// Where a strategy cannot supply what a case needs, the adapter returns null and
// the case records `skip` with the reason. It never fabricates a token, because
// a case that silently tests nothing is worse than one that reports a gap.

import type {
  GrantRequest,
  IssuedGrant,
  SeededStream,
  TargetAdapter,
  TargetCapabilities,
} from "../harness/adapter.ts";
import type { Role } from "../requirements/catalog.ts";
import { request } from "../harness/http.ts";

/** A grant the operator minted out of band, described so cases can match it. */
export type PreprovisionedGrant = {
  readonly accessToken: string;
  readonly grantId: string;
  readonly streams: readonly { readonly name: string; readonly fields: readonly string[] }[];
};

export type HttpTargetConfig = {
  readonly targetId: string;
  readonly targetVersion: string;
  readonly baseUrl: string;
  readonly roles: readonly Role[];
  readonly capabilities: TargetCapabilities;
  /** Streams the operator seeded, with the shape the suite needs to build requests. */
  readonly streams: readonly SeededStream[];
  readonly ownerToken?: string;
  /** A second subject's owner token. Without it, RS-12 cannot be demonstrated. */
  readonly foreignSubjectOwnerToken?: string;
  /** A token whose grant has already expired. Without it, expiry is not demonstrable. */
  readonly expiredGrantToken?: string;
  readonly grants?: {
    /** Grants minted out of band, matched to a case's request by stream and fields. */
    readonly preprovisioned?: readonly PreprovisionedGrant[];
    /**
     * An endpoint the suite may POST a grant request to, returning
     * `{ grant_id, access_token }`. Deployment-specific and not part of Core;
     * a target without one still runs every case that fits a preprovisioned grant.
     */
    readonly issueEndpoint?: string;
    /** An endpoint the suite may POST `{ grant_id }` to in order to revoke. */
    readonly revokeEndpoint?: string;
    /** Bearer credential authorizing the two endpoints above. */
    readonly adminToken?: string;
  };
};

function sameFieldSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * Whether a preprovisioned grant satisfies a case's request exactly.
 *
 * Exact match, not superset: a case narrowing a projection to two fields and
 * receiving a three-field grant would "pass" its leak check against a grant that
 * never excluded anything. Matching loosely here would quietly defeat the
 * field-projection oracle, so a near-miss is a skip rather than a substitution.
 */
function satisfies(grant: PreprovisionedGrant, wanted: GrantRequest): boolean {
  if (grant.streams.length !== wanted.streams.length) {
    return false;
  }
  return wanted.streams.every((want) => {
    const got = grant.streams.find((s) => s.name === want.name);
    return got !== undefined && sameFieldSet(got.fields, want.fields);
  });
}

export class HttpTargetAdapter implements TargetAdapter {
  readonly targetId: string;
  readonly targetVersion: string;
  readonly baseUrl: string;
  readonly roles: readonly Role[];
  readonly capabilities: TargetCapabilities;
  private readonly config: HttpTargetConfig;

  constructor(config: HttpTargetConfig) {
    this.config = config;
    this.targetId = config.targetId;
    this.targetVersion = config.targetVersion;
    this.baseUrl = config.baseUrl;
    this.roles = config.roles;
    this.capabilities = config.capabilities;
  }

  /**
   * Confirm the target is reachable and serving PDPP before any case runs.
   *
   * A target that is not listening produces a cascade of identical connection
   * failures, one per case, which reads like dozens of conformance defects. One
   * clear error here names the real problem instead.
   */
  async setup(): Promise<{ readonly streams: readonly SeededStream[] }> {
    let reachable: boolean;
    try {
      const probe = await request(this.baseUrl, "/.well-known/oauth-protected-resource");
      // Any HTTP status means something is listening and speaking HTTP. Whether
      // the document is correct is RS-16's job to judge, not setup's.
      reachable = probe.status > 0;
    } catch (error) {
      throw new Error(
        `Target ${this.targetId} is not reachable at ${this.baseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }. The suite tests a running server over HTTP; start the target before running it.`
      );
    }
    if (!reachable) {
      throw new Error(`Target ${this.targetId} at ${this.baseUrl} did not answer an HTTP probe.`);
    }
    return { streams: this.config.streams };
  }

  async teardown(): Promise<void> {
    // The suite did not create the target and does not tear it down. Any records
    // it seeded are the operator's to clean up, deliberately: silently deleting
    // data on someone else's server is not a test runner's business.
    return;
  }

  async issueGrant(wanted: GrantRequest): Promise<IssuedGrant | null> {
    const preprovisioned = this.config.grants?.preprovisioned?.find((g) => satisfies(g, wanted));
    if (preprovisioned) {
      return {
        grantId: preprovisioned.grantId,
        accessToken: preprovisioned.accessToken,
        streams: wanted.streams.map((s) => ({ name: s.name, fields: [...s.fields] })),
      };
    }

    const endpoint = this.config.grants?.issueEndpoint;
    if (!endpoint) {
      // No way to obtain this grant shape. The case records `skip`, naming the
      // gap, rather than being silently dropped.
      return null;
    }

    const response = await request(this.baseUrl, endpoint, {
      method: "POST",
      ...(this.config.grants?.adminToken && { token: this.config.grants.adminToken }),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wanted),
    });
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    const body = response.json as { grant_id?: string; access_token?: string } | undefined;
    if (!(body?.grant_id && body.access_token)) {
      return null;
    }
    return {
      grantId: body.grant_id,
      accessToken: body.access_token,
      streams: wanted.streams.map((s) => ({ name: s.name, fields: [...s.fields] })),
    };
  }

  async revokeGrant(grantId: string): Promise<void> {
    const endpoint = this.config.grants?.revokeEndpoint;
    if (!endpoint) {
      // Without a revocation path the AS-8 case cannot establish its precondition
      // and reports `skip`. Throwing here would misreport a configuration gap as
      // a conformance failure.
      return;
    }
    await request(this.baseUrl, endpoint, {
      method: "POST",
      ...(this.config.grants?.adminToken && { token: this.config.grants.adminToken }),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_id: grantId }),
    });
  }

  async ownerToken(): Promise<string | null> {
    return this.config.ownerToken ?? null;
  }

  async foreignSubjectOwnerToken(): Promise<string | null> {
    return this.config.foreignSubjectOwnerToken ?? null;
  }

  async expiredGrantToken(): Promise<string | null> {
    return this.config.expiredGrantToken ?? null;
  }
}

/**
 * Build an adapter from a JSON config file, so running against a real target is
 * a config change rather than a code change.
 */
export function httpTargetFromConfig(config: HttpTargetConfig): HttpTargetAdapter {
  return new HttpTargetAdapter(config);
}
