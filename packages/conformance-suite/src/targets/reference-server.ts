// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// A minimal, in-process PDPP resource server used to exercise the suite itself.
//
// This is NOT the PDPP reference implementation and makes no conformance claim
// on its behalf. It exists for one reason: a conformance suite whose oracles
// have never been shown to fail is untrustworthy. A test that asserts "the
// server refused the ungranted stream" passes equally against a correct server
// and against a suite whose assertion is unreachable. So this server is built
// with a `defects` switch, and the suite's own test file runs every negative
// oracle twice — once against the clean server (expecting pass) and once
// against a server with the matching defect enabled (expecting fail).
//
// That is the independent failure proof: each negative oracle is demonstrated
// to distinguish a conforming target from a violating one. Without the defect
// variants the suite would be a set of assertions nobody has ever seen fire.
//
// It speaks real HTTP over a real socket, so the suite exercises the same code
// path it would against a remote vendor: no in-process short circuit, no
// privileged access to internal state.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Behaviours that violate a specific normative requirement, for oracle proof. */
export type Defect =
  /** Serves any stream regardless of grant membership (violates RS-2). */
  | "ignore-grant-streams"
  /** Returns all schema fields regardless of the grant projection (RS-2). */
  | "ignore-field-projection"
  /** Silently ignores unknown query parameters instead of 400 (RS-10). */
  | "ignore-unknown-params"
  /** Accepts client-token filter[...] instead of 400 (RS-9). */
  | "accept-client-filters"
  /** Keeps serving a revoked grant (AS-8). */
  | "ignore-revocation"
  /** Omits resource_metadata from the 401 challenge (RS-16). */
  | "weak-401-challenge"
  /** Discloses current views/relationships to a client token (RS-15). */
  | "leak-current-metadata"
  /** Reads token kind from the token string instead of its principal (RS-4). */
  | "infer-token-kind-from-syntax"
  /** Serves any subject's store to any owner token (RS-12). */
  | "ignore-subject-scope"
  /** Declares self-export but refuses owner reads (RS-13). */
  | "declare-self-export-but-refuse";

export type Record_ = { readonly id: string } & Record<string, unknown>;

export interface StreamFixture {
  readonly cursorField?: string;
  readonly fields: readonly string[];
  readonly name: string;
  readonly primaryKey: readonly string[];
  readonly records: readonly Record_[];
  readonly semantics: "append_only" | "mutable_state";
}

interface GrantState {
  expired: boolean;
  readonly grantId: string;
  revoked: boolean;
  readonly streams: readonly { name: string; fields: readonly string[] }[];
  readonly subjectId: string;
}

/** What a bearer token resolves to, as an introspection response would report. */
type Principal = { kind: "client"; grantId: string } | { kind: "owner"; subjectId: string };

const SUPPORTED_VERSION = "2026-04-06";
const KNOWN_PARAMS = new Set(["limit", "cursor", "order", "fields", "changes_since"]);

const RECORDS_PATH = /^\/v1\/streams\/([^/]+)\/records$/;
const METADATA_PATH = /^\/v1\/streams\/([^/]+)$/;

/** The seeded subject. A second subject exists so cross-subject scoping is testable. */
export const SEEDED_SUBJECT = "subject_seeded";
export const FOREIGN_SUBJECT = "subject_foreign";

export class ReferenceServer {
  private server?: Server;
  private port = 0;
  private readonly grants = new Map<string, GrantState>();
  private readonly tokens = new Map<string, Principal>();
  private counter = 0;
  private readonly streams: readonly StreamFixture[];
  private readonly defects: ReadonlySet<Defect>;

  constructor(streams: readonly StreamFixture[], defects: ReadonlySet<Defect> = new Set()) {
    this.streams = streams;
    this.defects = defects;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private has(defect: Defect): boolean {
    return this.defects.has(defect);
  }

  /**
   * Resolve a token's principal to the enforcement context, or the denial that
   * Section 8 requires. A client token carries a grant whose lifecycle is
   * checked here; an owner token carries none (Section 8 "Grant enforcement").
   */
  private resolvePrincipal(
    principal: Principal
  ): { grant: GrantState | undefined; subjectId: string } | { denial: { code: string; message: string } } {
    if (principal.kind === "owner") {
      return { grant: undefined, subjectId: principal.subjectId };
    }
    const grant = this.grants.get(principal.grantId);
    if (!grant) {
      return { denial: { code: "grant_invalid", message: "Unknown grant." } };
    }
    if (grant.revoked && !this.has("ignore-revocation")) {
      return { denial: { code: "grant_revoked", message: "Grant was revoked." } };
    }
    if (grant.expired) {
      return { denial: { code: "grant_expired", message: "Grant has expired." } };
    }
    return { grant, subjectId: grant.subjectId };
  }

  async start(): Promise<void> {
    // Owner tokens for both subjects are minted up front; how an owner obtains
    // one is out of scope for Core (Section 8 "Authentication").
    this.tokens.set("owner-seeded", {
      kind: "owner",
      subjectId: SEEDED_SUBJECT,
    });
    this.tokens.set("owner-foreign", {
      kind: "owner",
      subjectId: FOREIGN_SUBJECT,
    });

    const server = createServer((req, res) => {
      this.handle(req.url ?? "/", req.headers, res);
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  issueGrant(
    requested: readonly { name: string; fields: readonly string[] }[],
    options: { expired?: boolean } = {}
  ): { grantId: string; accessToken: string } | null {
    // Reject a grant naming a stream this server does not serve: an AS must
    // validate against the retained declaration (Section 9 AS item 2).
    for (const s of requested) {
      if (!this.streams.some((fixture) => fixture.name === s.name)) {
        return null;
      }
    }
    this.counter += 1;
    const grantId = `grant_${this.counter}`;
    const accessToken = `token_${this.counter}`;
    this.grants.set(grantId, {
      grantId,
      subjectId: SEEDED_SUBJECT,
      streams: requested.map((s) => ({ name: s.name, fields: [...s.fields] })),
      revoked: false,
      expired: options.expired ?? false,
    });
    this.tokens.set(accessToken, { kind: "client", grantId });
    return { grantId, accessToken };
  }

  revokeGrant(grantId: string): void {
    const grant = this.grants.get(grantId);
    if (grant) {
      grant.revoked = true;
    }
  }

  private handle(url: string, headers: NodeJS.Dict<string | string[]>, res: import("node:http").ServerResponse): void {
    const parsed = new URL(url, "http://127.0.0.1");
    const path = parsed.pathname;

    const send = (status: number, body: unknown, extraHeaders: Record<string, string> = {}) => {
      this.counter += 1;
      res.writeHead(status, {
        "content-type": "application/json",
        "pdpp-version": SUPPORTED_VERSION,
        "request-id": `req_${this.counter}`,
        ...extraHeaders,
      });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };

    const error = (
      status: number,
      code: string,
      type: string,
      message: string,
      extraHeaders: Record<string, string> = {}
    ) => {
      send(status, { error: { type, code, message } }, extraHeaders);
    };

    // --- RFC 9728 protected resource metadata (RS-16) ---
    if (path === "/.well-known/oauth-protected-resource") {
      send(200, this.protectedResourceMetadata());
      return;
    }

    // --- Authentication (RS-4, RS-16) ---
    const principal = this.resolveToken(headers.authorization);
    if (!principal) {
      error(401, "authentication_error", "authentication_error", "Missing or invalid access token.", {
        "www-authenticate": this.bearerChallenge(),
      });
      return;
    }

    // --- PDPP-Version negotiation (RS-11) ---
    const requestedVersion = headers["pdpp-version"];
    if (typeof requestedVersion === "string" && requestedVersion !== SUPPORTED_VERSION) {
      error(400, "unsupported_version", "invalid_request_error", `PDPP-Version ${requestedVersion} is not supported.`);
      return;
    }

    // Resolve the client authorization context, mirroring what a separated RS
    // would read from an RFC 7662 introspection response.
    const resolved = this.resolvePrincipal(principal);
    if ("denial" in resolved) {
      error(403, resolved.denial.code, "permission_error", resolved.denial.message);
      return;
    }
    const { grant, subjectId } = resolved;

    // An owner token reaches only its own subject's store (RS-12). The seeded
    // fixtures belong to SEEDED_SUBJECT, so a foreign owner sees an empty store.
    const subjectScoped = subjectId === SEEDED_SUBJECT;

    // --- GET /v1/streams (RS-1) ---
    if (path === "/v1/streams") {
      const visible = this.streams.filter((s) => {
        if (principal.kind === "owner") {
          return subjectScoped;
        }
        return grant?.streams.some((g) => g.name === s.name) ?? false;
      });
      send(200, {
        object: "list",
        data: visible.map((s) => ({
          object: "stream",
          name: s.name,
          record_count: s.records.length,
        })),
      });
      return;
    }

    const recordsMatch = RECORDS_PATH.exec(path);
    const metadataMatch = METADATA_PATH.exec(path);
    const streamName = decodeURIComponent(recordsMatch?.[1] ?? metadataMatch?.[1] ?? "");
    const fixture = this.streams.find((s) => s.name === streamName);

    if (!fixture) {
      error(404, "not_found", "not_found_error", "Stream not found.");
      return;
    }

    // Stream access: grant membership for a client, subject scope for an owner.
    const grantedStream = grant?.streams.find((g) => g.name === streamName);
    const denial = this.denyStreamAccess(principal.kind, streamName, grantedStream !== undefined, subjectScoped);
    if (denial) {
      error(403, "grant_stream_not_allowed", "permission_error", denial);
      return;
    }

    // --- GET /v1/streams/{stream} (RS-14, RS-15) ---
    if (metadataMatch) {
      send(200, this.streamMetadata(fixture, principal.kind, grantedStream?.fields ?? []));
      return;
    }

    // --- GET /v1/streams/{stream}/records (RS-2, RS-5, RS-9, RS-10) ---
    if (recordsMatch) {
      const rejection = this.rejectUnsupportedParams([...parsed.searchParams.keys()], principal.kind);
      if (rejection) {
        error(400, "invalid_request", "invalid_request_error", rejection);
        return;
      }

      const projection =
        principal.kind === "client" && !this.has("ignore-field-projection")
          ? (grantedStream?.fields ?? [])
          : fixture.fields;

      const data = fixture.records.map((record) => ({
        object: "record",
        id: record.id,
        stream: fixture.name,
        data: Object.fromEntries(Object.entries(record).filter(([k]) => projection.includes(k))),
      }));

      send(200, {
        object: "list",
        url: path,
        has_more: false,
        data,
      });
      return;
    }

    error(404, "not_found", "not_found_error", "Not found.");
  }

  /**
   * Stream metadata, actor-specific per Section 8 "Get stream metadata": whole
   * for an owner token, closed projection for a client token.
   */
  private streamMetadata(
    fixture: StreamFixture,
    kind: Principal["kind"],
    grantedFields: readonly string[]
  ): Record<string, unknown> {
    const wholeDocument = kind === "owner" || this.has("leak-current-metadata");
    const fields = wholeDocument ? [...fixture.fields] : [...grantedFields];
    return {
      object: "stream_metadata",
      name: fixture.name,
      schema: { properties: Object.fromEntries(fields.map((f) => [f, {}])) },
      primary_key: [...fixture.primaryKey],
      ...(fixture.cursorField && { cursor_field: fixture.cursorField }),
      query: wholeDocument ? { range_filters: { [fixture.cursorField ?? "id"]: ["gte"] } } : {},
      views: wholeDocument ? [{ id: "basic", label: "Basic", fields: [...fixture.fields] }] : [],
      relationships: [],
    };
  }

  /**
   * The Section 8 query-parameter gate, returning a rejection message or
   * undefined. Two distinct rules share this seam: client-token predicate and
   * expansion parameters are off the v0.1 client surface (RS-9), and unknown
   * parameters are rejected rather than ignored for any caller (RS-10).
   */
  private rejectUnsupportedParams(params: readonly string[], kind: Principal["kind"]): string | undefined {
    if (kind === "client" && !this.has("accept-client-filters")) {
      const offending = params.find(
        (p) =>
          p.startsWith("filter[") ||
          p === "expand[]" ||
          p.startsWith("expand[") ||
          p.startsWith("expand_limit[") ||
          p === "view"
      );
      if (offending) {
        return `Parameter '${offending}' is not part of the v0.1 client-token query surface.`;
      }
    }
    if (!this.has("ignore-unknown-params")) {
      const unknown = params.find((p) => !(KNOWN_PARAMS.has(p) || p.startsWith("filter[") || p.startsWith("expand")));
      if (unknown) {
        return `Unknown query parameter '${unknown}'.`;
      }
    }
    return undefined;
  }

  /** The RFC 9728 document, including the four Section 8 `pdpp_` members. */
  private protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.baseUrl,
      resource_name: "PDPP conformance reference target",
      authorization_servers: [this.baseUrl],
      pdpp_core_query_base: "/v1",
      pdpp_token_kinds_supported: ["owner", "client"],
      pdpp_self_export_supported: true,
      pdpp_provider_connect_version: SUPPORTED_VERSION,
    };
  }

  /** Resolve a Bearer credential to its principal, as introspection would. */
  private resolveToken(authorization: string | string[] | undefined): Principal | undefined {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return undefined;
    }
    const credential = authorization.slice("Bearer ".length);
    const known = this.tokens.get(credential);
    if (known) {
      return known;
    }
    // The defect RS-4 exists to catch: deciding token kind from the token's
    // shape rather than from the principal it resolves to. A string that merely
    // starts like an owner credential is honoured as one.
    if (this.has("infer-token-kind-from-syntax") && credential.startsWith("owner-")) {
      return { kind: "owner", subjectId: SEEDED_SUBJECT };
    }
    return undefined;
  }

  /**
   * RFC 6750 Section 3 challenge carrying the RFC 9728 `resource_metadata`
   * parameter. The `weak-401-challenge` defect drops that parameter, which is
   * exactly what the RS-16 bootstrap oracle looks for.
   */
  private bearerChallenge(): string {
    if (this.has("weak-401-challenge")) {
      return "Bearer";
    }
    const metadata = `${this.baseUrl}/.well-known/oauth-protected-resource`;
    return `Bearer error="invalid_token", resource_metadata="${metadata}"`;
  }

  /**
   * Stream-level access denial, or undefined to proceed. A client token is
   * bounded by grant membership (RS-2); an owner token by subject scope (RS-12).
   */
  private denyStreamAccess(
    kind: Principal["kind"],
    streamName: string,
    inGrant: boolean,
    subjectScoped: boolean
  ): string | undefined {
    if (kind === "client") {
      return inGrant || this.has("ignore-grant-streams") ? undefined : `Grant does not include stream '${streamName}'.`;
    }
    if (this.has("declare-self-export-but-refuse")) {
      // Declares pdpp_self_export_supported in its metadata, then refuses the
      // owner read it advertised (RS-13).
      return "Self-export is not available.";
    }
    if (this.has("ignore-subject-scope")) {
      // Any owner token reaches any subject's store (RS-12).
      return undefined;
    }
    return subjectScoped ? undefined : "Owner token is scoped to a different subject.";
  }
}
